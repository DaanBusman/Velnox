/*
 * Velnox — self-hosted MSP management for Proxmox VE.
 * Copyright (C) The Velnox Foundation.
 *
 * Free software under the GNU Affero General Public License, version 3 or
 * later, supplemented with additional terms permitted by section 7 of that
 * licence covering attribution, origin and trademarks. See LICENSE and NOTICE.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import pino from 'pino';
import { loadWorkerConfig, redisConnection, secretValues } from '@velnox/config';
import { createPrismaClient, ensureLibraryDirs } from '@velnox/db';
import { JOB_NAMES, JOB_QUEUE, QUEUE_NAMES, rootRedactor } from '@velnox/shared';
import { Heartbeat } from './heartbeat';
import { processPing, type PingJobData, type PingJobResult } from './processors/ping.processor';
import { CredentialReader } from './inventory/credentials';
import {
  processDiscover,
  processProbe,
  processVerify,
  type DiscoverJobData,
  type InventoryContext,
  type ProbeJobData,
} from './inventory/inventory.processor';
import {
  RECONCILE_INTERVAL_MS,
  reconcileLostJobs,
  reconcileStaleDiscoveryRuns,
} from './jobs/reconcile';
import { runJob, type JobsContext } from './jobs/runner';
import {
  SCHEDULER_TICK_INTERVAL_MS,
  SCHEDULER_TICK_JOB,
  runSchedulerTick,
} from './inventory/scheduler';
import { buildBlockList, ownNetworks } from './library/address-guard';
import { createLibraryServices } from './library/services';
import {
  processSshProbe,
  processSshVerify,
  type SshProbeData,
  type SshVerifyData,
} from './library/ssh-setup';
import { LIBRARY_SWEEP_INTERVAL_MS, sweepLibrary } from './library/sweep';
import { Mailer } from './mail/mailer';
import { notifyProvisioned } from './provisioning/notify';
import type { ProvisioningServices } from './provisioning/playbook';
import { sweepProvisionings } from './provisioning/sweep';

/**
 * Velnox worker.
 *
 * This is the only service that performs outbound automation and the only one
 * that decrypts credentials for use (docs/tech-decisions.md ADR-009). It has no
 * listening port: nothing on the network can reach it, and its liveness is
 * reported through a Redis heartbeat.
 *
 * From phase 4 it runs a second queue: everything that talks to a hypervisor.
 * Its own queue because that work is slow and bursty and must not sit behind the
 * things an operator is waiting on.
 *
 * From phase 5 it runs a third: jobs. See `jobs/runner.ts`.
 *
 * From phase 5A it holds the ISO library's volume, and is the only process
 * that fetches into it, checks it, and copies out of it.
 */
async function bootstrap(): Promise<void> {
  const config = loadWorkerConfig();
  for (const secret of secretValues(config)) rootRedactor.remember(secret);

  const logger = pino({
    level: config.LOG_LEVEL,
    base: { service: 'worker', version: config.VELNOX_VERSION },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  });

  // The database is not needed by the ping processor, but connecting here proves
  // the worker's own database path at startup instead of at the first job that
  // needs it — which, from Phase 5, is every job.
  const prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
  await prisma.$connect();
  logger.info('Database connection established');

  const heartbeatRedis = new Redis({
    ...redisConnection(config),
    maxRetriesPerRequest: 2,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  });
  heartbeatRedis.on('error', (error) => logger.debug({ err: error }, 'Heartbeat Redis error'));

  const heartbeat = new Heartbeat(heartbeatRedis);
  heartbeat.start((error) => logger.warn({ err: rootRedactor.value(error) }, 'Heartbeat failed'));

  const worker = new Worker<PingJobData, PingJobResult>(
    QUEUE_NAMES.system,
    async (job: Job<PingJobData, PingJobResult>) => {
      switch (job.name) {
        case JOB_NAMES.ping:
          return processPing(job);
        default:
          // An unknown job name means the API and the worker are running
          // different versions. Failing loudly is correct: silently discarding
          // work would be worse than a visible error.
          throw new Error(`Unknown job type "${job.name}"`);
      }
    },
    {
      connection: {
        ...redisConnection(config),
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      },
      concurrency: config.WORKER_CONCURRENCY,
    },
  );

  worker.on('completed', (job, result) => {
    logger.info(
      { jobId: job.id, jobName: job.name, durationMs: result?.durationMs },
      'Job completed',
    );
  });

  worker.on('failed', (job, error) => {
    logger.error(
      { jobId: job?.id, jobName: job?.name, err: rootRedactor.value(error) },
      'Job failed',
    );
  });

  worker.on('error', (error) => {
    logger.error({ err: rootRedactor.value(error) }, 'Worker error');
  });

  // ------------------------------------------------------------------
  // Inventory
  // ------------------------------------------------------------------

  const credentials = new CredentialReader(prisma, config.MASTER_ENCRYPTION_KEY);
  const inventoryContext: InventoryContext = {
    prisma,
    credentials,
    log: (fields, message) => logger.info(fields, message),
  };

  // Before any queue worker starts: a test mail can be asked for at once.
  const mailer = new Mailer(prisma, credentials, config.VELNOX_VERSION);
  const sendTestMail = async (job: Job<{ to: string }>) => {
    await mailer.send(
      {
        to: job.data.to,
        subject: 'Velnox test mail',
        text: 'This mail was sent by Velnox to prove the outgoing mail settings work.\n\nNothing needs doing.',
      },
      { test: true },
    );
    return { ok: true };
  };

  // ------------------------------------------------------------------
  // ISO library
  // ------------------------------------------------------------------

  await ensureLibraryDirs(config.VELNOX_LIBRARY_DIR);
  const library = createLibraryServices({
    prisma,
    credentials,
    limits: {
      dir: config.VELNOX_LIBRARY_DIR,
      maxGb: config.VELNOX_LIBRARY_MAX_GB,
      minFreeGb: config.VELNOX_LIBRARY_MIN_FREE_GB,
    },
    /*
     * Read once, at startup. The worker's networks do not change while it runs,
     * and reading them per fetch would be a place for a race with nothing
     * gained.
     */
    blocked: buildBlockList({ ownNetworks: ownNetworks() }),
    userAgent: `Velnox/${config.VELNOX_VERSION} (ISO library)`,
    log: (fields, message) => logger.info(fields, message),
  });

  const inventoryQueue = new Queue(QUEUE_NAMES.inventory, {
    connection: { ...redisConnection(config), maxRetriesPerRequest: null },
  });

  const inventoryWorker = new Worker(
    QUEUE_NAMES.inventory,
    async (job: Job) => {
      switch (job.name) {
        case JOB_NAMES.inventoryProbe:
          return processProbe(job as Job<ProbeJobData>);
        case JOB_NAMES.inventoryVerify:
          return processVerify(job as Job<DiscoverJobData>, inventoryContext);
        case JOB_NAMES.inventoryDiscover:
          return processDiscover(job as Job<DiscoverJobData>, inventoryContext);
        case JOB_NAMES.inventorySshProbe:
          return processSshProbe(job as Job<SshProbeData>, inventoryContext);
        case JOB_NAMES.inventorySshVerify:
          return processSshVerify(job as Job<SshVerifyData>, inventoryContext);
        // On this queue because the API waits for it the way it waits for a
        // probe; it talks to a mail server, not a hypervisor.
        case JOB_NAMES.mailTest:
          return sendTestMail(job as Job<{ to: string }>);
        case SCHEDULER_TICK_JOB:
          return runSchedulerTick(prisma, inventoryQueue);
        default:
          throw new Error(`Unknown inventory job "${job.name}"`);
      }
    },
    {
      connection: {
        ...redisConnection(config),
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      },
      concurrency: config.WORKER_CONCURRENCY,
    },
  );

  inventoryWorker.on('failed', (job, error) => {
    // A discovery failure is a fact about somebody's cluster, not about Velnox,
    // so it is a warning here and a recorded run in the database. The error
    // level is reserved for the worker itself being broken.
    logger.warn(
      { jobId: job?.id, jobName: job?.name, err: rootRedactor.value(error) },
      'Inventory job failed',
    );
  });

  inventoryWorker.on('error', (error) => {
    logger.error({ err: rootRedactor.value(error) }, 'Inventory worker error');
  });

  /*
   * One repeating tick drives every cluster's schedule.
   *
   * `upsertJobScheduler` replaces the previous definition rather than adding a
   * second, so a worker restart — or a changed interval in a later release —
   * cannot leave two schedulers running.
   */
  await inventoryQueue.upsertJobScheduler(
    'inventory-tick',
    { every: SCHEDULER_TICK_INTERVAL_MS },
    { name: SCHEDULER_TICK_JOB },
  );

  // ------------------------------------------------------------------
  // Jobs
  // ------------------------------------------------------------------

  /*
   * A process identity, not a container one. A restarted worker in the same
   * container is a new owner: the jobs the old process held are lost, and must
   * be reconciled as such rather than quietly adopted by a process that has no
   * idea where they were.
   */
  const workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

  const jobsRedis = new Redis({
    ...redisConnection(config),
    maxRetriesPerRequest: 2,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  });
  jobsRedis.on('error', (error) => logger.debug({ err: error }, 'Jobs Redis error'));

  // ------------------------------------------------------------------
  // Mail and provisioning (Phase 5B)
  // ------------------------------------------------------------------

  const provisioning: ProvisioningServices = {
    prisma,
    credentials,
    library,
    notify: async (provisioningId) => {
      if (!(await mailer.enabled())) return 'skipped';
      return notifyProvisioned({
        prisma,
        credentials,
        mailer,
        productVersion: config.VELNOX_VERSION,
        provisioningId,
      });
    },
    pollIntervalMs: 10_000,
    // Windows with updates during Setup can take well over an hour.
    installTimeoutMs: { WINDOWS: 180 * 60_000, LINUX: 45 * 60_000 },
    credentialRetentionMs: 30 * 24 * 60 * 60_000,
  };

  const jobsContext: JobsContext = {
    prisma,
    redis: jobsRedis,
    workerId,
    library,
    provisioning,
    log: {
      info: (fields, message) => logger.info(fields, message),
      warn: (fields, message) => logger.warn(fields, message),
    },
  };

  const jobsWorker = new Worker<{ jobId: string }>(
    JOB_QUEUE,
    async (job) => runJob(jobsContext, job.data.jobId),
    {
      connection: {
        ...redisConnection(config),
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      },
      concurrency: config.WORKER_CONCURRENCY,
      /*
       * Never hand a stalled job to another worker. BullMQ's default is to
       * retry it, which for a job halfway through changing a cluster means doing
       * the first half twice. The reconciler below reports it as lost instead.
       */
      maxStalledCount: 0,
    },
  );

  jobsWorker.on('completed', (job, outcome) => {
    logger.info({ jobId: job.data.jobId, outcome }, 'Job run ended');
  });

  jobsWorker.on('failed', (job, error) => {
    // The job's own failure is recorded on the job; this is the runner itself
    // breaking, which is Velnox's problem rather than the cluster's.
    logger.error({ jobId: job?.data.jobId, err: rootRedactor.value(error) }, 'Job runner failed');
  });

  jobsWorker.on('error', (error) => {
    logger.error({ err: rootRedactor.value(error) }, 'Jobs worker error');
  });

  const reconcile = () =>
    Promise.all([reconcileLostJobs(jobsContext), reconcileStaleDiscoveryRuns(jobsContext)]).catch(
      (error: unknown) =>
        logger.error({ err: rootRedactor.value(error) }, 'Reconciling lost work failed'),
    );
  await reconcile();
  const reconcileTimer = setInterval(() => void reconcile(), RECONCILE_INTERVAL_MS);

  const sweep = () =>
    Promise.all([
      sweepLibrary(library)
        .then((result) => {
          if (Object.values(result).some((count) => count > 0)) {
            logger.warn(result, 'Swept the library');
          }
        })
        .catch((error: unknown) =>
          logger.error({ err: rootRedactor.value(error) }, 'Sweeping the library failed'),
        ),
      sweepProvisionings(prisma, credentials)
        .then((result) => {
          if (result.lost > 0) logger.warn(result, 'Swept provisioning records');
          else if (result.expired > 0) logger.info(result, 'Dropped expired VM credentials');
        })
        .catch((error: unknown) =>
          logger.error({ err: rootRedactor.value(error) }, 'Sweeping provisioning records failed'),
        ),
    ]);
  await sweep();
  const sweepTimer = setInterval(() => void sweep(), LIBRARY_SWEEP_INTERVAL_MS);

  logger.info(
    {
      queue: QUEUE_NAMES.system,
      inventoryQueue: QUEUE_NAMES.inventory,
      jobsQueue: JOB_QUEUE,
      workerId,
      concurrency: config.WORKER_CONCURRENCY,
      version: config.VELNOX_VERSION,
      commit: config.VELNOX_BUILD_COMMIT,
    },
    'Velnox worker started',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    // Let an in-flight job finish. From Phase 7 this matters a great deal: a
    // dist-upgrade must never be killed part-way through.
    clearInterval(reconcileTimer);
    clearInterval(sweepTimer);
    await worker.close();
    await inventoryWorker.close();
    await jobsWorker.close();
    jobsRedis.disconnect();
    await inventoryQueue.close();
    await heartbeat.stop();
    heartbeatRedis.disconnect();
    await prisma.$disconnect();

    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((error: unknown) => {
  // Startup failed, so the logger may not exist. This is the only place in the
  // service that writes to the console directly, and it redacts first.
  console.error(
    rootRedactor.text(error instanceof Error ? (error.stack ?? error.message) : String(error)),
  );
  process.exit(1);
});

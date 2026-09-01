import 'reflect-metadata';
import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import pino from 'pino';
import { loadWorkerConfig, redisConnection, secretValues } from '@velnox/config';
import { createPrismaClient } from '@velnox/db';
import { JOB_NAMES, QUEUE_NAMES, rootRedactor } from '@velnox/shared';
import { Heartbeat } from './heartbeat';
import { processPing, type PingJobData, type PingJobResult } from './processors/ping.processor';

/**
 * Velnox worker.
 *
 * This is the only service that performs outbound automation and the only one
 * that decrypts credentials for use (docs/tech-decisions.md ADR-009). It has no
 * listening port: nothing on the network can reach it, and its liveness is
 * reported through a Redis heartbeat.
 *
 * Phase 1 runs a single processor whose only purpose is to prove the api ->
 * Redis -> worker path end to end. The playbook runner arrives in Phase 5.
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

  logger.info(
    {
      queue: QUEUE_NAMES.system,
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
    await worker.close();
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

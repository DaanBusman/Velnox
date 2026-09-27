import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue, QueueEvents, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { redisConnection, type ApiConfig } from '@velnox/config';
import { API_CONFIG } from '../../config/config.module';
import { JOB_NAMES, JOB_QUEUE, QUEUE_NAMES, VelnoxError, ERROR_CODES } from '@velnox/shared';

/**
 * Queue producer.
 *
 * The API submits work and reads its state; it never executes work
 * (docs/tech-decisions.md ADR-009). This class is therefore deliberately
 * write-and-read-status only — there is no processor here and no code path from
 * an HTTP handler to a managed node.
 */
/** Thrown when a job the API is waiting on did not finish in time. */
export class JobTimeoutError extends Error {
  constructor(readonly jobId: string) {
    super(`Job ${jobId} did not finish within the time the request could wait`);
    this.name = 'JobTimeoutError';
  }
}

@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly connection: Redis;
  readonly system: Queue;
  readonly inventory: Queue;
  /** Phase 5 jobs. Carries a job id and nothing else; the row is the record. */
  readonly jobs: Queue;
  /**
   * Built lazily, because it opens its own blocking Redis connection.
   *
   * An API that never waits on a job should not hold one open, and most
   * requests never do.
   */
  private inventoryEvents: QueueEvents | null = null;

  constructor(@Inject(API_CONFIG) private readonly configuration: ApiConfig) {
    const config = this.configuration;
    // BullMQ requires maxRetriesPerRequest to be null on its connection: a
    // command that fails mid-operation must be retried, not abandoned.
    this.connection = new Redis({
      ...redisConnection(config),
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    this.connection.on('error', () => undefined);

    this.system = new Queue(QUEUE_NAMES.system, {
      connection: this.connection,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 3600, count: 100 },
        removeOnFail: { age: 86_400, count: 100 },
      },
    });

    /*
     * Its own queue, for the reason given in `QUEUE_NAMES`: work that talks to a
     * hypervisor is slow and bursty, and must not sit behind the things an
     * operator is waiting on.
     *
     * `attempts: 1` here too. Retrying is the Proxmox client's job, where it can
     * tell a timeout from a refused credential and a fingerprint mismatch from
     * either — BullMQ cannot, and a blind second attempt at "this host is not
     * who it claims to be" is worse than none.
     */
    this.inventory = new Queue(QUEUE_NAMES.inventory, {
      connection: this.connection,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 3600, count: 200 },
        removeOnFail: { age: 86_400, count: 200 },
      },
    });

    // One attempt, always. A job's retry is a new job with a parent, decided by
    // a person — see JobsService.retry — never BullMQ running it again.
    this.jobs = new Queue(JOB_QUEUE, {
      connection: this.connection,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 3600, count: 500 },
        removeOnFail: { age: 86_400, count: 500 },
      },
    });
  }

  /**
   * Put a job on the queue.
   *
   * Each call is a new queue entry, on purpose. A job parked for approval is
   * enqueued a second time when it is approved, and BullMQ silently ignores an
   * id it has seen before — so reusing the job's own id would leave an approved
   * job sitting in the database forever.
   *
   * What stops a job running twice is not the queue but the worker's claim: it
   * moves a job out of QUEUED only if it is still QUEUED, in one conditional
   * write. An approval clicked twice produces two queue entries, one run, and
   * one pickup that finds nothing to do.
   */
  async enqueueJob(jobId: string): Promise<void> {
    await this.jobs.add('run', { jobId }, { jobId: `${jobId}-${Date.now()}` });
  }

  /**
   * Take a queued job off the queue, if it is still there. Best effort: the
   * worker refuses to run a job that is no longer QUEUED in the database, so a
   * miss here costs one no-op pickup.
   */
  async dequeueJob(jobId: string): Promise<void> {
    const waiting = await this.jobs.getJobs(['waiting', 'delayed', 'prioritized']);
    await Promise.all(
      waiting
        .filter((entry) => (entry.data as { jobId?: string } | undefined)?.jobId === jobId)
        .map((entry) => entry.remove().catch(() => undefined)),
    );
  }

  /**
   * Submit a job and wait for its result.
   *
   * The API performs no outbound automation (ADR-009), so reading a certificate
   * off a customer's node is the worker's work — but an operator adding a
   * cluster is standing in front of a form, and "we have queued your request"
   * is not an answer to "is this the right machine?".
   *
   * So this is a request-scoped wait with a hard ceiling, used by exactly the
   * two endpoints where a person is waiting. Everything else enqueues and
   * returns. The real job system in phase 5 replaces it with a live event
   * stream, and this is deliberately the smallest thing that works until then.
   */
  async runAndWait<T>(
    name: string,
    payload: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<T> {
    this.inventoryEvents ??= new QueueEvents(QUEUE_NAMES.inventory, {
      connection: { ...redisConnection(this.configuration), maxRetriesPerRequest: null },
    });

    const job = await this.inventory.add(name, payload);
    if (!job.id) {
      throw new VelnoxError(ERROR_CODES.generic, {
        status: 500,
        message: 'Queue accepted the job but returned no id',
      });
    }

    try {
      return (await job.waitUntilFinished(this.inventoryEvents, timeoutMs)) as T;
    } catch (error) {
      /*
       * `waitUntilFinished` rejects both when the job failed and when the wait
       * timed out, and the two need different answers: a failure carries the
       * worker's message, a timeout means the job may still be running. The
       * job's own state is what tells them apart.
       */
      const state = await job.getState().catch(() => 'unknown');
      if (state === 'active' || state === 'waiting' || state === 'delayed') {
        throw new JobTimeoutError(job.id);
      }
      throw error;
    }
  }

  /** Enqueue without waiting. The normal case. */
  async enqueueInventory(name: string, payload: Record<string, unknown>): Promise<string> {
    const job = await this.inventory.add(name, payload);
    return job.id ?? '';
  }

  /**
   * Phase 1 queue self-test. Proves the api -> Redis -> worker path end to end.
   * Replaced by the real job system in Phase 5.
   */
  async enqueuePing(payload: { requestedAt: string }, options?: JobsOptions): Promise<string> {
    const job = await this.system.add(JOB_NAMES.ping, payload, options);
    if (!job.id) {
      throw new VelnoxError(ERROR_CODES.generic, {
        status: 500,
        message: 'Queue accepted the job but returned no id',
      });
    }
    return job.id;
  }

  async describeJob(id: string): Promise<{
    state: string;
    queuedAt: number | null;
    startedAt: number | null;
    finishedAt: number | null;
    attempts: number;
    returnValue: unknown;
    failedReason: string | null;
  } | null> {
    const job = await this.system.getJob(id);
    if (!job) return null;

    return {
      state: await job.getState(),
      queuedAt: job.timestamp ?? null,
      startedAt: job.processedOn ?? null,
      finishedAt: job.finishedOn ?? null,
      attempts: job.attemptsMade,
      returnValue: job.returnvalue ?? null,
      failedReason: job.failedReason ?? null,
    };
  }

  async counts(): Promise<Record<string, number>> {
    return this.system.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
  }

  async onModuleDestroy(): Promise<void> {
    await this.system.close();
    await this.inventory.close();
    await this.jobs.close();
    await this.inventoryEvents?.close();
    this.connection.disconnect();
  }
}

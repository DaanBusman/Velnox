import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { redisConnection, type ApiConfig } from '@velnox/config';
import { API_CONFIG } from '../../config/config.module';
import { JOB_NAMES, QUEUE_NAMES, VelnoxError, ERROR_CODES } from '@velnox/shared';

/**
 * Queue producer.
 *
 * The API submits work and reads its state; it never executes work
 * (docs/tech-decisions.md ADR-009). This class is therefore deliberately
 * write-and-read-status only — there is no processor here and no code path from
 * an HTTP handler to a managed node.
 */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly connection: Redis;
  readonly system: Queue;

  constructor(@Inject(API_CONFIG) config: ApiConfig) {
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
    this.connection.disconnect();
  }
}

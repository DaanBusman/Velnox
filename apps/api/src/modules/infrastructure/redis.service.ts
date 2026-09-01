import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { redisConnection, type ApiConfig } from '@velnox/config';
import { API_CONFIG } from '../../config/config.module';

/**
 * Redis connection used by the API for readiness probes and for reading the
 * worker's heartbeat. Queue producers get their own connection (see
 * QueueService) because BullMQ requires specific client options.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;

  constructor(@Inject(API_CONFIG) config: ApiConfig) {
    this.client = new Redis({
      ...redisConnection(config),
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      // Without a ceiling a lost Redis turns every request into a slow failure
      // instead of a fast one.
      connectTimeout: 5_000,
      retryStrategy: (times) => Math.min(times * 200, 5_000),
    });

    // ioredis emits 'error' on every reconnect attempt; an unhandled one would
    // crash the process. Readiness reporting is the readyz probe's job.
    this.client.on('error', () => undefined);
  }

  async ping(): Promise<number> {
    const started = Date.now();
    if (this.client.status === 'wait' || this.client.status === 'end') {
      await this.client.connect();
    }
    await this.client.ping();
    return Date.now() - started;
  }

  async onModuleDestroy(): Promise<void> {
    this.client.disconnect();
  }
}

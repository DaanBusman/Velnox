import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { redisConnection, type ApiConfig } from '@velnox/config';
import type { JobEventMessage } from '@velnox/shared';
import { API_CONFIG } from '../../config/config.module';

type Listener = (event: JobEventMessage) => void;

/**
 * Fans job events out from Redis to the browsers watching them.
 *
 * One pattern subscription per API process, not one connection per open
 * stream. A Redis connection in subscriber mode can do nothing else, and an
 * operator with the jobs page open in four tabs would otherwise hold four of
 * them — each an idle socket on Redis for as long as the tab lives.
 *
 * The subscription is opened on first use rather than at startup: an API that
 * nobody is watching jobs through should not hold a subscriber at all.
 */
@Injectable()
export class JobStreamHub implements OnModuleDestroy {
  private subscriber: Redis | null = null;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  /** Start receiving one job's events. Returns the function that stops it. */
  listen(jobId: string, listener: Listener): () => void {
    this.ensureSubscribed();

    let set = this.listeners.get(jobId);
    if (!set) {
      set = new Set();
      this.listeners.set(jobId, set);
    }
    set.add(listener);

    return () => {
      const current = this.listeners.get(jobId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(jobId);
    };
  }

  private ensureSubscribed(): void {
    if (this.subscriber) return;

    const subscriber = new Redis({
      ...redisConnection(this.config),
      // A subscriber must reconnect indefinitely: giving up would silently turn
      // every open stream into one that never receives another event.
      maxRetriesPerRequest: null,
      retryStrategy: (times) => Math.min(times * 200, 5_000),
    });
    subscriber.on('error', () => undefined);

    subscriber.on('pmessage', (_pattern, channel, raw) => {
      const jobId = /^velnox:job:([^:]+):events$/.exec(channel)?.[1];
      if (!jobId) return;
      const set = this.listeners.get(jobId);
      if (!set || set.size === 0) return;

      let event: JobEventMessage;
      try {
        event = JSON.parse(raw) as JobEventMessage;
      } catch {
        return;
      }
      for (const listener of set) listener(event);
    });

    void subscriber.psubscribe('velnox:job:*:events');
    this.subscriber = subscriber;
  }

  onModuleDestroy(): void {
    this.subscriber?.disconnect();
    this.listeners.clear();
  }
}

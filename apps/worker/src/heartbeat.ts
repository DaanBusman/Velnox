import type { Redis } from 'ioredis';
import { REDIS_KEYS, WORKER_HEARTBEAT_INTERVAL_MS, WORKER_HEARTBEAT_MAX_AGE_MS } from '@velnox/shared';

/**
 * Worker liveness.
 *
 * The worker deliberately has no listening port (docs/service-diagram.md), so it
 * cannot answer an HTTP probe. Instead it refreshes a timestamp in Redis, which
 * both the container health check and the API's readiness probe read. The key
 * carries a TTL slightly longer than the staleness threshold so that a dead
 * worker's heartbeat disappears on its own rather than lingering as a stale
 * value that looks merely old.
 */
export class Heartbeat {
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly redis: Redis) {}

  async beat(): Promise<void> {
    await this.redis.set(
      REDIS_KEYS.workerHeartbeat,
      String(Date.now()),
      'PX',
      WORKER_HEARTBEAT_MAX_AGE_MS * 2,
    );
  }

  start(onError: (error: unknown) => void): void {
    const tick = (): void => {
      this.beat().catch(onError);
    };
    tick();
    this.timer = setInterval(tick, WORKER_HEARTBEAT_INTERVAL_MS);
    // Do not hold the event loop open purely to keep beating.
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    // Remove the heartbeat on a clean shutdown so the API reports the worker as
    // absent immediately, rather than waiting for the key to age out.
    await this.redis.del(REDIS_KEYS.workerHeartbeat).catch(() => undefined);
  }
}

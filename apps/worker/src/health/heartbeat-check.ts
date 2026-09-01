/**
 * Container health check for the worker.
 *
 * Run as `node dist/health/heartbeat-check.js`. Exits 0 when this worker's
 * heartbeat is fresh, 1 otherwise. Written as a separate entry point because the
 * worker has no HTTP surface for Docker to probe.
 */
import { Redis } from 'ioredis';
import { loadWorkerConfig, redisConnection } from '@velnox/config';
import { REDIS_KEYS, WORKER_HEARTBEAT_MAX_AGE_MS } from '@velnox/shared';

async function main(): Promise<number> {
  const config = loadWorkerConfig();
  const redis = new Redis({
    ...redisConnection(config),
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 3_000,
    retryStrategy: () => null,
  });
  redis.on('error', () => undefined);

  try {
    await redis.connect();
    const raw = await redis.get(REDIS_KEYS.workerHeartbeat);
    if (!raw) {
      process.stderr.write('worker heartbeat missing\n');
      return 1;
    }
    const age = Date.now() - Number(raw);
    if (!Number.isFinite(age) || age > WORKER_HEARTBEAT_MAX_AGE_MS) {
      process.stderr.write(`worker heartbeat stale (${Math.round(age / 1000)}s)\n`);
      return 1;
    }
    return 0;
  } catch (error) {
    process.stderr.write(`worker health check failed: ${(error as Error).message}\n`);
    return 1;
  } finally {
    redis.disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch(() => process.exit(1));

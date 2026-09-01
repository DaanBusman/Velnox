import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { REDIS_KEYS, WORKER_HEARTBEAT_MAX_AGE_MS } from '@velnox/shared';
import { Heartbeat } from './heartbeat';

function fakeRedis() {
  return {
    set: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1),
  } as unknown as Redis & { set: ReturnType<typeof vi.fn>; del: ReturnType<typeof vi.fn> };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Heartbeat', () => {
  it('writes a timestamp under the shared key with an expiry', async () => {
    const redis = fakeRedis();
    await new Heartbeat(redis).beat();

    expect(redis.set).toHaveBeenCalledTimes(1);
    const [key, value, mode, ttl] = redis.set.mock.calls[0]!;
    expect(key).toBe(REDIS_KEYS.workerHeartbeat);
    expect(Number(value)).toBeGreaterThan(0);
    expect(mode).toBe('PX');
    // The key must outlive the staleness threshold, or a healthy worker would
    // look absent between beats; but it must expire, or a dead worker's
    // heartbeat would linger forever and be reported as merely old.
    expect(ttl).toBeGreaterThan(WORKER_HEARTBEAT_MAX_AGE_MS);
  });

  it('beats immediately on start rather than waiting a full interval', () => {
    vi.useFakeTimers();
    const redis = fakeRedis();
    new Heartbeat(redis).start(() => undefined);
    expect(redis.set).toHaveBeenCalledTimes(1);
  });

  it('keeps beating on the interval', () => {
    vi.useFakeTimers();
    const redis = fakeRedis();
    const heartbeat = new Heartbeat(redis);
    heartbeat.start(() => undefined);

    vi.advanceTimersByTime(35_000);
    expect(redis.set.mock.calls.length).toBeGreaterThan(1);
  });

  it('removes the key on a clean shutdown so the API sees the worker leave at once', async () => {
    const redis = fakeRedis();
    const heartbeat = new Heartbeat(redis);
    await heartbeat.stop();
    expect(redis.del).toHaveBeenCalledWith(REDIS_KEYS.workerHeartbeat);
  });

  it('reports beat failures instead of throwing into the timer', () => {
    vi.useFakeTimers();
    const redis = fakeRedis();
    redis.set.mockRejectedValueOnce(new Error('redis down'));
    const onError = vi.fn();

    expect(() => new Heartbeat(redis).start(onError)).not.toThrow();
  });
});

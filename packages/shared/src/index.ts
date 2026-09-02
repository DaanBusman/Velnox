export * from './errors';
export * from './permissions';
export * from './redaction';
export * from './system';

/**
 * Queue and job names shared between the API (producer) and the worker (consumer).
 *
 * BullMQ builds its Redis keys as `bull:<queue>:<suffix>`, so a queue name may not
 * itself contain a colon — it throws at construction if one does. Hyphens it is.
 */
export const QUEUE_NAMES = {
  system: 'velnox-system',
} as const;

/** BullMQ's constraint on queue names, asserted in tests so it cannot regress. */
export const isValidQueueName = (name: string): boolean =>
  name.length > 0 && !name.includes(':');

export const JOB_NAMES = {
  ping: 'system.ping',
} as const;

/** Redis keys owned by the worker. The health check reads the heartbeat. */
export const REDIS_KEYS = {
  workerHeartbeat: 'velnox:worker:heartbeat',
} as const;

/** How often the worker refreshes its heartbeat, and how stale is too stale. */
export const WORKER_HEARTBEAT_INTERVAL_MS = 10_000;
export const WORKER_HEARTBEAT_MAX_AGE_MS = 45_000;

export const API_PREFIX = 'api/v1';

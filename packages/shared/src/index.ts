/*
 * Velnox — self-hosted MSP management for Proxmox VE.
 * Copyright (C) The Velnox Foundation.
 *
 * Free software under the GNU Affero General Public License, version 3 or
 * later, supplemented with additional terms permitted by section 7 of that
 * licence covering attribution, origin and trademarks. See LICENSE and NOTICE.
 */
export * from './errors';
export * from './fingerprint';
export * from './permissions';
export * from './redaction';
export * from './slug';
export * from './system';

/**
 * Queue and job names shared between the API (producer) and the worker (consumer).
 *
 * BullMQ builds its Redis keys as `bull:<queue>:<suffix>`, so a queue name may not
 * itself contain a colon — it throws at construction if one does. Hyphens it is.
 */
export const QUEUE_NAMES = {
  system: 'velnox-system',
  /**
   * Everything that talks to a hypervisor.
   *
   * Its own queue rather than a job name on the system queue, because its jobs
   * are slow, bursty and network-bound: a discovery run against fifteen nodes
   * must not sit behind a queue that also carries the things an operator is
   * waiting on.
   */
  inventory: 'velnox-inventory',
} as const;

/** BullMQ's constraint on queue names, asserted in tests so it cannot regress. */
export const isValidQueueName = (name: string): boolean => name.length > 0 && !name.includes(':');

export const JOB_NAMES = {
  ping: 'system.ping',

  /**
   * Read a host's certificate without authenticating to it.
   *
   * The first half of adding a cluster: an operator cannot confirm a
   * fingerprint they have not been shown. Carries no credential, by design.
   */
  inventoryProbe: 'inventory.probe',
  /** Prove the stored credential works against the pinned certificate. */
  inventoryVerify: 'inventory.verify',
  /** Read a cluster's whole inventory and write it down. */
  inventoryDiscover: 'inventory.discover',
} as const;

/** Redis keys owned by the worker. The health check reads the heartbeat. */
export const REDIS_KEYS = {
  workerHeartbeat: 'velnox:worker:heartbeat',
} as const;

/** How often the worker refreshes its heartbeat, and how stale is too stale. */
export const WORKER_HEARTBEAT_INTERVAL_MS = 10_000;
export const WORKER_HEARTBEAT_MAX_AGE_MS = 45_000;

export const API_PREFIX = 'api/v1';

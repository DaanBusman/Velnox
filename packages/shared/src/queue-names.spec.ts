import { describe, expect, it } from 'vitest';
import { isValidQueueName, JOB_NAMES, QUEUE_NAMES, REDIS_KEYS } from './index';

describe('queue naming', () => {
  // BullMQ composes Redis keys as `bull:<queue>:<suffix>` and rejects a queue
  // name containing a colon at construction time. That failure only appears when
  // a container starts, so it is asserted here instead.
  it('every queue name is accepted by BullMQ', () => {
    for (const name of Object.values(QUEUE_NAMES)) {
      expect(isValidQueueName(name), `queue name "${name}" contains a colon`).toBe(true);
    }
  });

  it('rejects a name with a colon', () => {
    expect(isValidQueueName('velnox:system')).toBe(false);
    expect(isValidQueueName('')).toBe(false);
  });

  it('job names are namespaced and stable', () => {
    for (const name of Object.values(JOB_NAMES)) {
      expect(name).toMatch(/^[a-z][a-z0-9]*\.[a-z][a-z0-9_]*$/);
    }
  });

  // Plain Redis keys are not queue names and may use colons — the conventional
  // separator. Keeping the distinction explicit stops the fix above from being
  // "corrected" back later.
  it('plain Redis keys may use colons', () => {
    expect(REDIS_KEYS.workerHeartbeat).toContain(':');
  });
});

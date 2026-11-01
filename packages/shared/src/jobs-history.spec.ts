import { describe, expect, it } from 'vitest';
import { JOB_STATUSES, TERMINAL_JOB_STATUSES, jobOutOfSight } from './jobs';

const since = new Date('2026-10-01T00:00:00Z');
const before = new Date('2026-09-30T23:59:59Z');
const after = new Date('2026-10-01T00:00:01Z');

describe('jobs out of sight after the period', () => {
  it('hides a job that finished before the period began', () => {
    for (const status of TERMINAL_JOB_STATUSES) {
      expect(jobOutOfSight({ status, finishedAt: before, queuedAt: before }, since)).toBe(true);
    }
  });

  it('keeps a job that finished within it, however long ago it was queued', () => {
    expect(jobOutOfSight({ status: 'SUCCEEDED', finishedAt: after, queuedAt: before }, since)).toBe(
      false,
    );
  });

  it('never hides an unfinished job, however old', () => {
    for (const status of JOB_STATUSES.filter((s) => !TERMINAL_JOB_STATUSES.has(s))) {
      expect(jobOutOfSight({ status, finishedAt: null, queuedAt: before }, since)).toBe(false);
    }
  });

  it('dates a finished job without an end by when it was queued', () => {
    expect(jobOutOfSight({ status: 'CANCELLED', finishedAt: null, queuedAt: before }, since)).toBe(
      true,
    );
    expect(jobOutOfSight({ status: 'CANCELLED', finishedAt: null, queuedAt: after }, since)).toBe(
      false,
    );
  });
});

import { describe, expect, it } from 'vitest';
import type { JobStatus } from '@velnox/shared';
import { isTimeZone, jobActivityDays } from './job-activity';

const row = (status: JobStatus, at: string | null) => ({
  status,
  finishedAt: at ? new Date(at) : null,
});

describe('jobActivityDays', () => {
  const now = new Date('2026-11-21T12:00:00Z');

  it('has every day of the period, oldest first, also the empty ones', () => {
    const days = jobActivityDays([], 3, 'UTC', now);
    expect(days.map((d) => d.date)).toEqual(['2026-11-19', '2026-11-20', '2026-11-21']);
    expect(days[0]).toEqual({
      date: '2026-11-19',
      succeeded: 0,
      partial: 0,
      failed: 0,
      cancelled: 0,
    });
  });

  it('counts each way a job can end, a rollback as a failure', () => {
    const [day] = jobActivityDays(
      [
        row('SUCCEEDED', '2026-11-21T01:00:00Z'),
        row('SUCCEEDED', '2026-11-21T02:00:00Z'),
        row('PARTIALLY_SUCCEEDED', '2026-11-21T03:00:00Z'),
        row('FAILED', '2026-11-21T04:00:00Z'),
        row('ROLLED_BACK', '2026-11-21T05:00:00Z'),
        row('CANCELLED', '2026-11-21T06:00:00Z'),
      ],
      1,
      'UTC',
      now,
    );
    expect(day).toMatchObject({ succeeded: 2, partial: 1, failed: 2, cancelled: 1 });
  });

  it('leaves out what has not finished, and what lies before the period', () => {
    const days = jobActivityDays(
      [row('RUNNING', '2026-11-21T01:00:00Z'), row('FAILED', null), row('FAILED', '2026-11-01T01:00:00Z')],
      2,
      'UTC',
      now,
    );
    expect(days.every((d) => d.failed === 0 && d.succeeded === 0)).toBe(true);
  });

  it('puts a job on the day it was in the reader’s time zone', () => {
    // 23:30 UTC on the 20th is already the 21st in Amsterdam.
    const late = [row('SUCCEEDED', '2026-11-20T23:30:00Z')];
    const utc = jobActivityDays(late, 2, 'UTC', now);
    const amsterdam = jobActivityDays(late, 2, 'Europe/Amsterdam', now);
    expect(utc.find((d) => d.date === '2026-11-20')?.succeeded).toBe(1);
    expect(amsterdam.find((d) => d.date === '2026-11-21')?.succeeded).toBe(1);
  });

  it('takes today from the time zone as well', () => {
    const justAfterMidnightThere = new Date('2026-11-21T23:30:00Z');
    const days = jobActivityDays([], 1, 'Europe/Amsterdam', justAfterMidnightThere);
    expect(days[0]?.date).toBe('2026-11-22');
  });

  it('neither skips nor repeats a day across a clock change', () => {
    // Clocks went back in Amsterdam on 25 October 2026.
    const days = jobActivityDays([], 4, 'Europe/Amsterdam', new Date('2026-10-27T10:00:00Z'));
    expect(days.map((d) => d.date)).toEqual([
      '2026-10-24',
      '2026-10-25',
      '2026-10-26',
      '2026-10-27',
    ]);
  });

  it('crosses a month and a year', () => {
    const days = jobActivityDays([], 2, 'UTC', new Date('2027-01-01T08:00:00Z'));
    expect(days.map((d) => d.date)).toEqual(['2026-12-31', '2027-01-01']);
  });
});

describe('isTimeZone', () => {
  it('knows a real zone and refuses anything else', () => {
    expect(isTimeZone('Europe/Amsterdam')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
    expect(isTimeZone("UTC'; DROP")).toBe(false);
  });
});

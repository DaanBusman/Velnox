import type { JobActivityDay, JobStatus } from '@velnox/shared';

/** The most finished jobs one reading counts; the response says when it reached this. */
export const JOB_ACTIVITY_MAX_ROWS = 20_000;

const OUTCOME: Partial<Record<JobStatus, keyof Omit<JobActivityDay, 'date'>>> = {
  SUCCEEDED: 'succeeded',
  PARTIALLY_SUCCEEDED: 'partial',
  FAILED: 'failed',
  ROLLED_BACK: 'failed',
  CANCELLED: 'cancelled',
};

/** Whether this is a time zone the runtime knows. */
export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Finished jobs per calendar day in the reader's time zone, oldest first.
 *
 * Every day of the period is present, also one with nothing on it: a day without
 * a row would close up on a chart and read as if the period were shorter.
 */
export function jobActivityDays(
  rows: readonly { status: JobStatus; finishedAt: Date | null }[],
  days: number,
  timeZone: string,
  now: Date,
): JobActivityDay[] {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const dateOf = (moment: Date) => {
    const field = (type: string) => parts.formatToParts(moment).find((p) => p.type === type)!.value;
    return `${field('year')}-${field('month')}-${field('day')}`;
  };

  // Counted back on the calendar, not in 24-hour steps: a day with a clock
  // change is 23 or 25 hours long, and stepping by hours would skip or repeat it.
  const [year, month, day] = dateOf(now).split('-').map(Number) as [number, number, number];
  const result: JobActivityDay[] = [];
  const byDate = new Map<string, JobActivityDay>();
  for (let back = days - 1; back >= 0; back -= 1) {
    const date = new Date(Date.UTC(year, month - 1, day - back)).toISOString().slice(0, 10);
    const entry = { date, succeeded: 0, partial: 0, failed: 0, cancelled: 0 };
    result.push(entry);
    byDate.set(date, entry);
  }

  for (const row of rows) {
    const outcome = OUTCOME[row.status];
    if (!outcome || !row.finishedAt) continue;
    const entry = byDate.get(dateOf(row.finishedAt));
    if (entry) entry[outcome] += 1;
  }
  return result;
}

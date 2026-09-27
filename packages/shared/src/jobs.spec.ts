import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACTIVE_JOB_STATUSES,
  InvalidJobTransitionError,
  JOB_STATUSES,
  TERMINAL_JOB_STATUSES,
  assertTransition,
  canTransition,
  jobTransitions,
  type JobStatus,
} from './jobs';

describe('job state machine', () => {
  const table = jobTransitions();

  /*
   * The acceptance criterion is "every invalid transition throws", so this
   * walks every one of the hundred ordered pairs rather than a sample. A
   * sampled test of a transition table passes happily while the one pair
   * nobody thought of is wrong.
   */
  it('allows exactly the listed transitions and throws on every other pair', () => {
    let allowed = 0;
    let refused = 0;

    for (const from of JOB_STATUSES) {
      for (const to of JOB_STATUSES) {
        if (table[from].includes(to)) {
          expect(() => assertTransition(from, to)).not.toThrow();
          allowed += 1;
        } else {
          expect(() => assertTransition(from, to)).toThrow(InvalidJobTransitionError);
          refused += 1;
        }
      }
    }

    expect(allowed + refused).toBe(JOB_STATUSES.length ** 2);
    // A table where everything is allowed would pass the loop above; this is
    // the line that says it is not that table.
    expect(refused).toBeGreaterThan(allowed);
  });

  it('never lets a job stay where it is', () => {
    for (const status of JOB_STATUSES) {
      expect(canTransition(status, status)).toBe(false);
    }
  });

  it('gives terminal states no way out', () => {
    for (const status of TERMINAL_JOB_STATUSES) {
      expect(table[status]).toEqual([]);
    }
  });

  it('lets every active state fail, so no job can be stuck', () => {
    for (const status of ACTIVE_JOB_STATUSES) {
      expect(canTransition(status, 'FAILED')).toBe(true);
    }
  });

  it('lets every active state be cancelled', () => {
    for (const status of ACTIVE_JOB_STATUSES) {
      expect(canTransition(status, 'CANCELLED')).toBe(true);
    }
  });

  it('partitions the statuses into active and terminal with nothing left over', () => {
    const union = new Set<JobStatus>([...ACTIVE_JOB_STATUSES, ...TERMINAL_JOB_STATUSES]);
    expect([...union].sort()).toEqual([...JOB_STATUSES].sort());
    for (const status of ACTIVE_JOB_STATUSES) expect(TERMINAL_JOB_STATUSES.has(status)).toBe(false);
  });

  it('sends an approved job back to the queue rather than straight to running', () => {
    // The API approves; only the worker runs (ADR-009).
    expect(canTransition('WAITING_APPROVAL', 'QUEUED')).toBe(true);
    expect(canTransition('WAITING_APPROVAL', 'RUNNING')).toBe(false);
  });

  it('only rolls back from a state in which something was changed', () => {
    const from = JOB_STATUSES.filter((status) => canTransition(status, 'ROLLED_BACK'));
    expect(from.sort()).toEqual(['RUNNING', 'VALIDATING']);
  });

  it('names both ends in the error', () => {
    try {
      assertTransition('SUCCEEDED', 'RUNNING');
      throw new Error('did not throw');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidJobTransitionError);
      expect((error as InvalidJobTransitionError).from).toBe('SUCCEEDED');
      expect((error as InvalidJobTransitionError).to).toBe('RUNNING');
    }
  });
});

describe('the active set and the database agree', () => {
  /*
   * The partial unique index on `jobs.concurrency_key` is what actually stops
   * two jobs touching one cluster. It lists active states in SQL, and this list
   * lists them in TypeScript. If they drift, the index either lets a second job
   * in or refuses one after the first has finished — so the migration is read
   * and compared, the same way the tenancy guard reads schema.prisma.
   */
  it('lists the same states as the concurrency index', () => {
    const migrations = join(process.cwd(), '..', 'db', 'prisma', 'migrations');
    const sql = readFileSync(join(migrations, '20260927090000_job_system', 'migration.sql'), 'utf8');

    const match = /CREATE UNIQUE INDEX "jobs_one_active_per_key"[\s\S]*?WHERE[\s\S]*?IN \(([^)]*)\)/.exec(
      sql,
    );
    expect(match, 'concurrency index not found in the migration').not.toBeNull();

    const inIndex = [...match![1]!.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).sort();
    expect(inIndex).toEqual([...ACTIVE_JOB_STATUSES].sort());
  });
});

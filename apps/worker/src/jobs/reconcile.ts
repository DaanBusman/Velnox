import { withSystemScope, type Prisma } from '@velnox/db';
import { JOB_EVENT_KEYS, assertTransition, type JobStatus } from '@velnox/shared';
import { recordEvent, type JobsContext } from './runner';

/**
 * Jobs whose worker is gone.
 *
 * A job in PREFLIGHT, RUNNING or VALIDATING belongs to one worker, held by a
 * lease that worker renews every ten seconds. If the lease has lapsed, the
 * worker is not renewing it — it crashed, was killed, lost its database, or was
 * redeployed mid-job — and the job will never move again on its own.
 *
 * Such a job is failed with `job.worker_lost`, and **not** retried. It may have
 * been halfway through changing a cluster; running it again from the top would
 * do the first half twice. The error message says so in both languages, and a
 * person decides what happens next.
 *
 * Runs when a worker starts and on an interval after that, so a job is
 * reconciled whether or not its own worker ever comes back.
 */

/** How often a running worker looks for lost jobs. */
export const RECONCILE_INTERVAL_MS = 15_000;

const OWNED: JobStatus[] = ['PREFLIGHT', 'RUNNING', 'VALIDATING'];

/** The condition for "nobody holds this": owned status, lease absent or past. */
export const lostJobWhere = (now: Date): Prisma.JobWhereInput => ({
  status: { in: OWNED },
  OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
});

export async function reconcileLostJobs(context: JobsContext, now = new Date()): Promise<number> {
  return withSystemScope('reconciling jobs belongs to no request', async () => {
    const lost = await context.prisma.job.findMany({
      where: lostJobWhere(now),
      select: { id: true, status: true, workerId: true },
    });

    let reconciled = 0;

    for (const job of lost) {
      const from = job.status as JobStatus;
      assertTransition(from, 'FAILED');

      // Conditional on the job still being lost: a worker that was merely slow
      // and has just renewed its lease keeps its job.
      const failed = await recordEvent(
        context,
        job.id,
        {
          level: 'ERROR',
          key: JOB_EVENT_KEYS.workerLost,
          message: `Worker ${job.workerId ?? 'unknown'} stopped renewing its lease; the job was not restarted`,
          data: { worker: job.workerId },
        },
        {
          guard: { id: job.id, ...lostJobWhere(now), status: from },
          data: {
            status: 'FAILED',
            errorCode: 'job.worker_lost',
            errorMessage: 'The worker stopped while running this job. It was not restarted automatically.',
            finishedAt: now,
            leaseUntil: null,
          },
        },
      );

      if (!failed) continue;
      reconciled += 1;

      await context.prisma.jobStep.updateMany({
        where: { jobId: job.id, status: 'RUNNING' },
        data: { status: 'FAILED', finishedAt: now, error: 'The worker stopped during this step' },
      });
      await context.prisma.jobStep.updateMany({
        where: { jobId: job.id, status: 'PENDING' },
        data: { status: 'SKIPPED' },
      });

      context.log.warn({ jobId: job.id, worker: job.workerId }, 'Reconciled a job whose worker was lost');
    }

    return reconciled;
  });
}

import type { Prisma } from '@prisma/client';
import type { VelnoxPrismaClient } from './client';

/**
 * Appending a job event, for the two services that write them.
 *
 * The worker writes most events; the API writes the ones that are decisions —
 * cancelling a job that has not started, approving, rejecting. Both need the
 * same guarantee, so both go through here: the event's sequence number comes
 * from incrementing `jobs.event_seq` inside the transaction that inserts the
 * event, which row-locks the job. Two writers serialise, a rollback takes the
 * increment with it, and sequence numbers never repeat and never skip. A browser
 * reconnecting with "everything after 41" can trust the answer.
 *
 * Redaction is the caller's job, before it gets here: this package does not know
 * the redactor, and should not have to.
 */

export interface JobEventWrite {
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  key: string;
  stepKey?: string | null;
  /** Already redacted. */
  message: string;
  /** Already redacted. */
  data?: Record<string, string | number | boolean | null>;
}

export interface JobChange {
  /** The job must still match this for the change — and the event — to happen. */
  guard: Prisma.JobWhereInput;
  data: Prisma.JobUpdateManyMutationInput;
}

export interface AppendedJobEvent {
  seq: number;
  at: Date;
  status: string;
  progressPct: number | null;
}

/**
 * Write the event, and optionally change the job in the same transaction.
 *
 * Returns `null` when a guard was given and the job no longer matched it — the
 * caller lost a race, and nothing was written.
 */
export async function appendJobEvent(
  prisma: VelnoxPrismaClient,
  jobId: string,
  event: JobEventWrite,
  change?: JobChange,
): Promise<AppendedJobEvent | null> {
  return prisma.$transaction(async (tx) => {
    if (change) {
      const moved = await tx.job.updateMany({
        where: { id: jobId, ...change.guard },
        data: change.data,
      });
      if (moved.count === 0) return null;
    }

    const job = await tx.job.update({
      where: { id: jobId },
      data: { eventSeq: { increment: 1 } },
      select: { eventSeq: true, status: true, progressPct: true },
    });

    const row = await tx.jobEvent.create({
      data: {
        jobId,
        seq: job.eventSeq,
        level: event.level,
        eventKey: event.key,
        stepKey: event.stepKey ?? null,
        message: event.message,
        data: event.data ?? {},
        status: job.status,
        progressPct: job.progressPct,
      },
      select: { at: true },
    });

    return { seq: job.eventSeq, at: row.at, status: job.status, progressPct: job.progressPct };
  });
}

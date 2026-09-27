import type { Redis } from 'ioredis';
import { appendJobEvent, withSystemScope, type Prisma, type VelnoxPrismaClient } from '@velnox/db';
import {
  JOB_EVENT_KEYS,
  JOB_LEASE_MS,
  assertTransition,
  jobCancelKey,
  jobEventChannel,
  rootRedactor,
  type JobEventLevel,
  type JobEventMessage,
  type JobStatus,
} from '@velnox/shared';
import { StepError, playbookFor, type StepContext, type StepDefinition } from './playbooks';

/**
 * The job runner.
 *
 * One call runs one job from wherever it is up to the next place it stops:
 * finished, failed, cancelled, or parked for approval. A job that is approved
 * comes back through here and carries on from the step after the gate, because
 * every step's outcome is in the database and the runner skips what is done.
 *
 * **Ownership.** While a job is PREFLIGHT, RUNNING or VALIDATING it belongs to
 * one worker process, named in `worker_id` and held by a lease the runner
 * renews. Every status write is conditional on still holding it. That matters
 * in exactly one situation, and it is the one that would otherwise corrupt a
 * record: this worker stalls long enough for its lease to lapse, another worker
 * fails the job as lost, and then this one wakes up and tries to write
 * SUCCEEDED over the top. The conditional write misses, and the runner stops.
 */

export interface JobsContext {
  prisma: VelnoxPrismaClient;
  /** Commands and publishing. Not the BullMQ connection. */
  redis: Redis;
  /** Unique per process, so a restarted worker is a different owner. */
  workerId: string;
  log: {
    info(fields: Record<string, unknown>, message: string): void;
    warn(fields: Record<string, unknown>, message: string): void;
  };
}

export type RunOutcome =
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'WAITING_APPROVAL'
  | 'NOT_CLAIMED'
  | 'LOST';

/** Largest single log entry kept. Beyond this the entry is cut and marked. */
export const LOG_ENTRY_LIMIT = 16 * 1024;

/** How often the runner looks for a cancellation request while a step runs. */
const CANCEL_POLL_MS = 500;

/** States in which a job belongs to a worker. */
const OWNED: JobStatus[] = ['PREFLIGHT', 'RUNNING', 'VALIDATING'];

class OwnershipLost extends Error {
  constructor(readonly jobId: string) {
    super(`Job ${jobId} is no longer held by this worker`);
    this.name = 'OwnershipLost';
  }
}

type EventData = Record<string, string | number | boolean | null>;

interface EventInput {
  level: JobEventLevel;
  key: string;
  stepKey?: string | null;
  message: string;
  data?: EventData;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Redact, append (see `appendJobEvent` in @velnox/db for the sequencing
 * guarantee), then publish. `null` when a guard was given and the job no longer
 * matched it: this worker lost a race, and nothing was written.
 */
export async function recordEvent(
  context: JobsContext,
  jobId: string,
  event: EventInput,
  change?: { data: Prisma.JobUpdateManyMutationInput; guard: Prisma.JobWhereInput },
): Promise<JobEventMessage | null> {
  const message = rootRedactor.text(event.message);
  const data = (rootRedactor.value(event.data ?? {}) ?? {}) as EventData;

  const written = await appendJobEvent(
    context.prisma,
    jobId,
    { level: event.level, key: event.key, stepKey: event.stepKey ?? null, message, data },
    change,
  );

  if (!written) return null;

  const published: JobEventMessage = {
    jobId,
    seq: written.seq,
    at: written.at.toISOString(),
    level: event.level,
    key: event.key,
    stepKey: event.stepKey ?? null,
    message,
    data,
    status: written.status as JobStatus,
    progressPct: written.progressPct,
  };

  /*
   * Published after the commit, never before: a subscriber that receives an
   * event must be able to read it back. A publish that fails is not a failed
   * job — the event is in the database, and a browser that missed it gets it
   * on reconnect by sequence number.
   */
  await context.redis.publish(jobEventChannel(jobId), JSON.stringify(published)).catch(() => {
    context.log.warn({ jobId, seq: published.seq }, 'Could not publish job event');
  });

  return published;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export async function runJob(context: JobsContext, jobId: string): Promise<RunOutcome> {
  return withSystemScope('a job runs on behalf of whoever queued it, not of a request', () =>
    run(context, jobId),
  );
}

async function run(context: JobsContext, jobId: string): Promise<RunOutcome> {
  const { prisma, workerId } = context;
  const leaseUntil = () => new Date(Date.now() + JOB_LEASE_MS);

  // ---- claim --------------------------------------------------------------
  // QUEUED → PREFLIGHT, only if it is still QUEUED. A job cancelled while it
  // sat on the queue, or picked up twice, is simply not ours.
  assertTransition('QUEUED', 'PREFLIGHT');
  const claimed = await recordEvent(
    context,
    jobId,
    { level: 'INFO', key: JOB_EVENT_KEYS.claimed, message: `Claimed by worker ${workerId}`, data: { worker: workerId } },
    {
      guard: { status: 'QUEUED' },
      data: { status: 'PREFLIGHT', workerId, leaseUntil: leaseUntil(), startedAt: new Date() },
    },
  );
  if (!claimed) return 'NOT_CLAIMED';

  const job = await prisma.job.findUniqueOrThrow({
    where: { id: jobId },
    select: { type: true, params: true, createdByUserId: true, tenantId: true },
  });

  let status: JobStatus = 'PREFLIGHT';
  const owned = { id: jobId, workerId } satisfies Prisma.JobWhereInput;

  /** Move the job, conditionally on this worker still holding it in `status`. */
  const move = async (
    to: JobStatus,
    event: EventInput,
    extra: Prisma.JobUpdateManyMutationInput = {},
  ): Promise<void> => {
    assertTransition(status, to);
    const done = await recordEvent(context, jobId, event, {
      guard: { ...owned, status },
      data: { status: to, ...extra },
    });
    if (!done) throw new OwnershipLost(jobId);
    status = to;
  };

  // ---- lease and cancellation watch ---------------------------------------
  const controller = new AbortController();
  let lost = false;

  const renew = setInterval(() => {
    void prisma.job
      .updateMany({
        where: { ...owned, status: { in: OWNED } },
        data: { leaseUntil: leaseUntil() },
      })
      .then((result) => {
        if (result.count === 0) {
          lost = true;
          controller.abort(new OwnershipLost(jobId));
        }
      })
      .catch(() => undefined);
  }, JOB_LEASE_MS / 3);

  const watch = setInterval(() => {
    void context.redis
      .exists(jobCancelKey(jobId))
      .then((flag) => {
        if (flag) controller.abort(new Error('cancelled'));
      })
      .catch(() => undefined);
  }, CANCEL_POLL_MS);

  /** Record a cancellation: the interrupted step failed, the rest skipped. */
  const finishCancelled = async (steps: StepDefinition[], seen: Map<string, string>, interrupted: string | null) => {
    if (interrupted) {
      // The step began and did not finish, so it is recorded as failed with
      // that reason rather than skipped: "this step never ran" would be untrue.
      await prisma.jobStep.update({
        where: { jobId_stepKey: { jobId, stepKey: interrupted } },
        data: { status: 'FAILED', finishedAt: new Date(), error: 'Interrupted: the job was cancelled' },
      });
      seen.set(interrupted, 'FAILED');
    }
    await skipRemaining(prisma, jobId, steps, seen, interrupted);
    await move(
      'CANCELLED',
      {
        level: 'WARN',
        key: JOB_EVENT_KEYS.cancelled,
        stepKey: interrupted,
        message: interrupted ? `Cancelled during ${interrupted}` : 'Cancelled between steps',
        data: { interrupted: interrupted !== null },
      },
      { finishedAt: new Date(), leaseUntil: null, currentStep: null },
    );
  };

  const cancelRequested = async (): Promise<boolean> => {
    if (controller.signal.aborted && !lost) return true;
    // The database is the record; Redis is the fast path. Both are checked, so
    // a flushed Redis cannot swallow a cancellation.
    const row = await prisma.job.findUnique({
      where: { id: jobId },
      select: { cancelRequestedAt: true },
    });
    return row?.cancelRequestedAt != null;
  };

  try {
    // ---- preflight --------------------------------------------------------
    let steps: StepDefinition[];
    try {
      steps = playbookFor(job.type, job.params).steps;
    } catch (error) {
      await move(
        'FAILED',
        { level: 'ERROR', key: JOB_EVENT_KEYS.failed, message: describe(error) },
        { errorCode: codeOf(error), errorMessage: rootRedactor.text(describe(error)), finishedAt: new Date(), leaseUntil: null },
      );
      return 'FAILED';
    }

    await prisma.jobStep.createMany({
      data: steps.map((step, index) => ({
        jobId,
        stepKey: step.key,
        phase: step.phase,
        sequence: index + 1,
      })),
      skipDuplicates: true,
    });

    await move('RUNNING', {
      level: 'INFO',
      key: JOB_EVENT_KEYS.started,
      message: `Running ${steps.length} step(s)`,
      data: { steps: steps.length },
    });

    const recorded = new Map(
      (
        await prisma.jobStep.findMany({
          where: { jobId },
          select: { stepKey: true, status: true },
        })
      ).map((row) => [row.stepKey, row.status]),
    );

    const taskCount = steps.filter((step) => step.kind === 'task').length || 1;
    let tasksDone = steps.filter(
      (step) => step.kind === 'task' && recorded.get(step.key) === 'SUCCEEDED',
    ).length;

    // ---- steps ------------------------------------------------------------
    for (const step of steps) {
      const previous = recorded.get(step.key);
      if (previous === 'SUCCEEDED' || previous === 'SKIPPED') continue;

      if (await cancelRequested()) {
        await finishCancelled(steps, recorded, null);
        return 'CANCELLED';
      }

      if (step.kind === 'approval') {
        const parked = await approvalGate(context, jobId, job.tenantId, step, job.createdByUserId, move);
        if (parked === 'PARKED') return 'WAITING_APPROVAL';
        if (parked === 'REJECTED') return 'FAILED';
        recorded.set(step.key, 'SUCCEEDED');
        continue;
      }

      await prisma.jobStep.update({
        where: { jobId_stepKey: { jobId, stepKey: step.key } },
        data: { status: 'RUNNING', startedAt: new Date(), attempt: { increment: 1 } },
      });
      const started = await recordEvent(
        context,
        jobId,
        { level: 'INFO', key: JOB_EVENT_KEYS.stepStarted, stepKey: step.key, message: `Step ${step.key} started` },
        { guard: { ...owned, status: 'RUNNING' }, data: { currentStep: step.key, currentPhase: step.phase } },
      );
      if (!started) throw new OwnershipLost(jobId);

      const stepContext: StepContext = {
        signal: controller.signal,
        progress: async (pct) => {
          const bounded = Math.max(0, Math.min(100, Math.round(pct)));
          const overall = Math.round(((tasksDone + bounded / 100) / taskCount) * 100);
          const reported = await recordEvent(
            context,
            jobId,
            {
              level: 'DEBUG',
              key: JOB_EVENT_KEYS.progress,
              stepKey: step.key,
              message: `Step ${step.key} at ${bounded}%`,
              data: { stepPct: bounded, overallPct: overall },
            },
            { guard: { ...owned, status: 'RUNNING' }, data: { progressPct: overall } },
          );
          if (!reported) throw new OwnershipLost(jobId);
        },
        log: async (stream, text) => {
          const clean = rootRedactor.text(text);
          const truncated = clean.length > LOG_ENTRY_LIMIT;
          await prisma.jobLog.create({
            data: {
              jobId,
              stepKey: step.key,
              stream,
              content: truncated ? clean.slice(0, LOG_ENTRY_LIMIT) : clean,
              truncated,
            },
          });
        },
        sleep: (ms) => abortableSleep(ms, controller.signal),
      };

      try {
        const output = await step.run(stepContext);
        await prisma.jobStep.update({
          where: { jobId_stepKey: { jobId, stepKey: step.key } },
          data: {
            status: 'SUCCEEDED',
            finishedAt: new Date(),
            output: output ? (rootRedactor.value(output) as Prisma.InputJsonValue) : undefined,
          },
        });
        recorded.set(step.key, 'SUCCEEDED');
        tasksDone += 1;
        await recordEvent(context, jobId, {
          level: 'INFO',
          key: JOB_EVENT_KEYS.stepSucceeded,
          stepKey: step.key,
          message: `Step ${step.key} succeeded`,
        });
      } catch (error) {
        if (lost || error instanceof OwnershipLost) throw new OwnershipLost(jobId);

        if (controller.signal.aborted) {
          await finishCancelled(steps, recorded, step.key);
          return 'CANCELLED';
        }

        await prisma.jobStep.update({
          where: { jobId_stepKey: { jobId, stepKey: step.key } },
          data: { status: 'FAILED', finishedAt: new Date(), error: rootRedactor.text(describe(error)) },
        });
        await skipRemaining(prisma, jobId, steps, recorded, step.key);
        await move(
          'FAILED',
          {
            level: 'ERROR',
            key: JOB_EVENT_KEYS.failed,
            stepKey: step.key,
            message: describe(error),
            data: { code: codeOf(error) },
          },
          {
            errorCode: codeOf(error),
            errorMessage: rootRedactor.text(describe(error)),
            finishedAt: new Date(),
            leaseUntil: null,
          },
        );
        return 'FAILED';
      }
    }

    await move(
      'SUCCEEDED',
      { level: 'INFO', key: JOB_EVENT_KEYS.succeeded, message: 'All steps succeeded' },
      { progressPct: 100, finishedAt: new Date(), leaseUntil: null, currentStep: null },
    );
    return 'SUCCEEDED';
  } catch (error) {
    if (error instanceof OwnershipLost) {
      context.log.warn({ jobId, workerId }, 'Job was taken from this worker; stopping');
      return 'LOST';
    }
    throw error;
  } finally {
    clearInterval(renew);
    clearInterval(watch);
    await context.redis.del(jobCancelKey(jobId)).catch(() => undefined);
  }
}

/**
 * Handle an approval step.
 *
 * Decided and approved: the gate is passed. Undecided: park the job and let go
 * of it. Rejected: the API already failed the job, so there is nothing to run.
 */
async function approvalGate(
  context: JobsContext,
  jobId: string,
  tenantId: string,
  step: Extract<StepDefinition, { kind: 'approval' }>,
  requestedBy: string | null,
  move: (to: JobStatus, event: EventInput, extra?: Prisma.JobUpdateManyMutationInput) => Promise<void>,
): Promise<'PASSED' | 'PARKED' | 'REJECTED'> {
  const { prisma } = context;

  const existing = await prisma.approval.findFirst({
    where: { jobId, stepKey: step.key },
    orderBy: { requestedAt: 'desc' },
  });

  if (existing?.decision === 'APPROVED') {
    await prisma.jobStep.update({
      where: { jobId_stepKey: { jobId, stepKey: step.key } },
      data: {
        status: 'SUCCEEDED',
        startedAt: existing.requestedAt,
        finishedAt: existing.decidedAt ?? new Date(),
        output: { approvedBy: existing.decidedByUserId },
      },
    });
    await recordEvent(context, jobId, {
      level: 'INFO',
      key: JOB_EVENT_KEYS.stepSucceeded,
      stepKey: step.key,
      message: `Approval gate ${step.key} passed`,
    });
    return 'PASSED';
  }

  if (existing?.decision === 'REJECTED') return 'REJECTED';

  if (!existing) {
    await prisma.approval.create({
      data: {
        jobId,
        // A trigger sets this to the job's own tenant whatever is supplied; it
        // is passed because the column is required. See the Phase 5 migration.
        tenantId,
        stepKey: step.key,
        requiredPermission: step.requiredPermission,
        reason: step.reason,
        changeSet: step.changeSet,
        requireDifferentApprover: step.requireDifferentApprover,
      },
    });
  }

  await move(
    'WAITING_APPROVAL',
    {
      level: 'WARN',
      key: JOB_EVENT_KEYS.approvalRequested,
      stepKey: step.key,
      message: step.reason,
      data: {
        permission: step.requiredPermission,
        differentApprover: step.requireDifferentApprover,
        requestedBy: requestedBy,
      },
    },
    // Let go entirely: a parked job belongs to nobody until it is approved.
    { workerId: null, leaseUntil: null, currentStep: step.key },
  );
  return 'PARKED';
}

async function skipRemaining(
  prisma: VelnoxPrismaClient,
  jobId: string,
  steps: StepDefinition[],
  recorded: Map<string, string>,
  after: string | null,
): Promise<void> {
  const keys = steps
    .map((step) => step.key)
    .filter((key) => key !== after && !['SUCCEEDED', 'FAILED', 'SKIPPED'].includes(recorded.get(key) ?? ''));
  if (keys.length === 0) return;
  await prisma.jobStep.updateMany({
    where: { jobId, stepKey: { in: keys }, status: { in: ['PENDING', 'RUNNING'] } },
    data: { status: 'SKIPPED' },
  });
  for (const key of keys) recorded.set(key, 'SKIPPED');
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const abortError = () => Object.assign(new Error('Aborted'), { name: 'AbortError' });

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const codeOf = (error: unknown): string => (error instanceof StepError ? error.code : 'generic');

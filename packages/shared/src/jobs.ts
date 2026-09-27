/**
 * The job system's vocabulary: states, the transitions between them, and the
 * names things are known by on the queue, on Redis and on the wire.
 *
 * One file for all of it because the API, the worker and the frontend each need
 * part of it and must agree on every part. The state machine in particular is
 * enforced in two places — the worker when it runs a job, the API when an
 * operator cancels or approves one — and two copies of a transition table are
 * two tables that will one day disagree about whether a cancelled job can be
 * approved.
 */

/**
 * Where a job is in its life.
 *
 * Mirrors docs/architecture.md section 9: `queued → preflight → waiting_approval
 * → running → validating → {succeeded | partially_succeeded | failed |
 * rolled_back | cancelled}`.
 */
export const JOB_STATUSES = [
  'QUEUED',
  'PREFLIGHT',
  'WAITING_APPROVAL',
  'RUNNING',
  'VALIDATING',
  'SUCCEEDED',
  'PARTIALLY_SUCCEEDED',
  'FAILED',
  'ROLLED_BACK',
  'CANCELLED',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

/** A job in one of these will never change again. */
export const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set([
  'SUCCEEDED',
  'PARTIALLY_SUCCEEDED',
  'FAILED',
  'ROLLED_BACK',
  'CANCELLED',
]);

/**
 * A job in one of these holds its concurrency key.
 *
 * `WAITING_APPROVAL` is in the set on purpose. A job parked for approval has
 * already decided what it is going to do to a cluster; letting a second job
 * start against that cluster while the first waits would mean approving a
 * change set that no longer describes the cluster it will run on.
 *
 * The migration's partial unique index lists the same five states. A test
 * compares the two, because this is the list that has to be right.
 */
export const ACTIVE_JOB_STATUSES: ReadonlySet<JobStatus> = new Set([
  'QUEUED',
  'PREFLIGHT',
  'WAITING_APPROVAL',
  'RUNNING',
  'VALIDATING',
]);

/**
 * Every legal move, and nothing else.
 *
 * Read as: from the key, the job may go to any state in the list. A state not
 * listed as a key has no way out.
 *
 * Choices worth knowing about:
 *
 * - **Anything active can fail.** A worker that dies mid-step, a guard that
 *   blocks, an exception in preflight — failure is always reachable, because
 *   "stuck in RUNNING forever" is the outcome this table exists to rule out.
 * - **Anything active can be cancelled**, including a job waiting for approval.
 *   Cancellation of a *running* job is honoured at the next step boundary by the
 *   runner; the table only says the destination is legal.
 * - **Approval returns a job to QUEUED, not to RUNNING.** Approval is a decision
 *   made in the API, and the API does not run work (ADR-009). It puts the job
 *   back on the queue; the worker picks it up and makes the move to RUNNING
 *   itself, the same way it does for every job.
 * - **Rejection is FAILED**, not CANCELLED. Nobody withdrew the job; somebody
 *   decided it should not happen, and that is a failure with a reason.
 * - **ROLLED_BACK is only reachable from RUNNING and VALIDATING**, the two
 *   states in which something has actually been changed that could be undone.
 */
const TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  QUEUED: ['PREFLIGHT', 'RUNNING', 'CANCELLED', 'FAILED'],
  PREFLIGHT: ['WAITING_APPROVAL', 'RUNNING', 'CANCELLED', 'FAILED'],
  WAITING_APPROVAL: ['QUEUED', 'CANCELLED', 'FAILED'],
  RUNNING: [
    'WAITING_APPROVAL',
    'VALIDATING',
    'SUCCEEDED',
    'PARTIALLY_SUCCEEDED',
    'FAILED',
    'ROLLED_BACK',
    'CANCELLED',
  ],
  VALIDATING: ['SUCCEEDED', 'PARTIALLY_SUCCEEDED', 'FAILED', 'ROLLED_BACK', 'CANCELLED'],
  SUCCEEDED: [],
  PARTIALLY_SUCCEEDED: [],
  FAILED: [],
  ROLLED_BACK: [],
  CANCELLED: [],
};

export class InvalidJobTransitionError extends Error {
  constructor(
    readonly from: JobStatus,
    readonly to: JobStatus,
  ) {
    super(`A job cannot go from ${from} to ${to}`);
    this.name = 'InvalidJobTransitionError';
  }
}

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Throws unless the move is in the table. */
export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) throw new InvalidJobTransitionError(from, to);
}

/** The table itself, for the tests and for documentation. */
export const jobTransitions = (): Readonly<Record<JobStatus, readonly JobStatus[]>> => TRANSITIONS;

export const isTerminal = (status: JobStatus): boolean => TERMINAL_JOB_STATUSES.has(status);
export const isActive = (status: JobStatus): boolean => ACTIVE_JOB_STATUSES.has(status);

// ---------------------------------------------------------------------------
// Steps, events, logs
// ---------------------------------------------------------------------------

export const JOB_STEP_STATUSES = [
  'PENDING',
  'RUNNING',
  'SKIPPED',
  'SUCCEEDED',
  'FAILED',
  'ROLLED_BACK',
] as const;

export type JobStepStatus = (typeof JOB_STEP_STATUSES)[number];

export const JOB_EVENT_LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'] as const;
export type JobEventLevel = (typeof JOB_EVENT_LEVELS)[number];

/**
 * What an event is about.
 *
 * Stable identifiers the frontend translates, like error codes (ADR-019): an
 * event's `message` is an English diagnostic for logs, and what a person reads
 * is `jobs.event.<key>` in their own language, filled from the event's data.
 */
export const JOB_EVENT_KEYS = {
  queued: 'job.queued',
  /** A worker took the job off the queue and is preparing to run it. */
  claimed: 'job.claimed',
  /** Preparation is done and the first step is about to run. */
  started: 'job.started',
  stepStarted: 'step.started',
  stepSucceeded: 'step.succeeded',
  stepFailed: 'step.failed',
  stepSkipped: 'step.skipped',
  progress: 'step.progress',
  approvalRequested: 'approval.requested',
  approved: 'approval.approved',
  rejected: 'approval.rejected',
  cancelRequested: 'job.cancel_requested',
  cancelled: 'job.cancelled',
  succeeded: 'job.succeeded',
  failed: 'job.failed',
  workerLost: 'job.worker_lost',
} as const;

export type JobEventKey = (typeof JOB_EVENT_KEYS)[keyof typeof JOB_EVENT_KEYS];

/** What travels over the stream. The same shape the events endpoint returns. */
export interface JobEventMessage {
  jobId: string;
  /** Per-job, strictly increasing, from 1. Doubles as the SSE event id. */
  seq: number;
  at: string;
  level: JobEventLevel;
  key: JobEventKey | string;
  stepKey: string | null;
  /** English, for logs and support. Not what the interface shows. */
  message: string;
  data: Record<string, string | number | boolean | null>;
  /** The job's status after this event, so a client needs no second read. */
  status: JobStatus;
  progressPct: number | null;
}

// ---------------------------------------------------------------------------
// Names on the queue and on Redis
// ---------------------------------------------------------------------------

/**
 * The queue jobs run on.
 *
 * Separate from `velnox-system` and `velnox-inventory` because its settings
 * are different in the one respect that matters: a job that stalls is **never
 * retried** (`maxStalledCount: 0`). BullMQ's default is to hand a stalled job to
 * another worker, which for a job that was halfway through changing a cluster
 * means doing the first half twice. `job.worker_lost` exists because that
 * outcome is to be reported, not repeated.
 */
export const JOB_QUEUE = 'velnox-jobs';

/** Job types. A type names a playbook in the worker's registry. */
export const JOB_TYPES = {
  /**
   * A job that does nothing but take time, report on itself and honour
   * cancellation — the acceptance vehicle for this phase, in the way
   * `system.ping` was for Phase 1. Restricted to `system.manage`.
   */
  selftest: 'system.selftest',
} as const;

export type JobType = (typeof JOB_TYPES)[keyof typeof JOB_TYPES];

/** Pub/sub channel carrying one job's events. */
export const jobEventChannel = (jobId: string): string => `velnox:job:${jobId}:events`;

/**
 * The cancellation flag.
 *
 * A key rather than a message, because the runner checks it between steps and a
 * message published while nobody was listening would be lost. The database's
 * `cancel_requested_at` is the record; this is the fast path the runner polls.
 */
export const jobCancelKey = (jobId: string): string => `velnox:job:${jobId}:cancel`;

/**
 * How long a runner's claim on a job lasts without being renewed.
 *
 * The runner renews it every third of this. A job still marked RUNNING with a
 * claim older than this belongs to a worker that is no longer there, and is
 * failed with `job.worker_lost` by whichever worker notices first.
 */
export const JOB_LEASE_MS = 30_000;

// ---------------------------------------------------------------------------
// system.selftest parameters
//
// Here rather than beside the playbook in the worker, because the API parses
// them too: a bad request is refused with a validation error when it is made,
// not accepted and failed a minute later.
// ---------------------------------------------------------------------------

export interface SelftestParams {
  /** How many work steps. */
  steps: number;
  /** How long each one takes. */
  secondsPerStep: number;
  /** Fail deliberately at this step (1-based), to exercise the failure path. */
  failAtStep: number | null;
  /** Park for approval before this step (1-based). */
  approvalBeforeStep: number | null;
  requireDifferentApprover: boolean;
}

export const SELFTEST_LIMITS = {
  steps: { min: 1, max: 20 },
  secondsPerStep: { min: 1, max: 120 },
} as const;

/** Parse and clamp self-test parameters. Anything unusable becomes its default. */
export function parseSelftestParams(raw: unknown): SelftestParams {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const int = (value: unknown, fallback: number) =>
    typeof value === 'number' && Number.isInteger(value) ? value : fallback;
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

  const steps = clamp(int(input.steps, 5), SELFTEST_LIMITS.steps.min, SELFTEST_LIMITS.steps.max);
  const optionalStep = (value: unknown) => {
    const n = int(value, 0);
    return n >= 1 && n <= steps ? n : null;
  };

  return {
    steps,
    secondsPerStep: clamp(
      int(input.secondsPerStep, 3),
      SELFTEST_LIMITS.secondsPerStep.min,
      SELFTEST_LIMITS.secondsPerStep.max,
    ),
    failAtStep: optionalStep(input.failAtStep),
    approvalBeforeStep: optionalStep(input.approvalBeforeStep),
    requireDifferentApprover: input.requireDifferentApprover === true,
  };
}


// ---------------------------------------------------------------------------
// What the API returns
// ---------------------------------------------------------------------------

export interface JobSummary {
  id: string;
  tenantId: string;
  tenantName: string;
  type: string;
  status: JobStatus;
  progressPct: number | null;
  currentStep: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** A catalogue code the interface translates. */
  errorCode: string | null;
  /** Redacted English diagnostic, for support. Not shown as the headline. */
  errorDetail: string | null;
  createdBy: { id: string; email: string } | null;
  targetKind: string | null;
  targetIds: string[];
  concurrencyKey: string | null;
  parentJobId: string | null;
  cancelRequested: boolean;
  /** The last event sequence number, so a stream can start from here. */
  eventSeq: number;
}

export interface JobStepSummary {
  key: string;
  phase: string | null;
  sequence: number;
  status: JobStepStatus;
  attempt: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

export interface ApprovalSummary {
  id: string;
  stepKey: string;
  requiredPermission: string;
  reason: string;
  changeSet: Record<string, unknown>;
  requireDifferentApprover: boolean;
  requestedAt: string;
  decidedAt: string | null;
  decision: 'APPROVED' | 'REJECTED' | null;
  decidedBy: string | null;
  decisionNote: string | null;
}

export interface JobDetail extends JobSummary {
  params: Record<string, unknown>;
  steps: JobStepSummary[];
  approvals: ApprovalSummary[];
  retries: { id: string; status: JobStatus; queuedAt: string }[];
}

export interface JobLogLine {
  /** A bigint in the database, a string here. */
  id: string;
  stepKey: string | null;
  stream: 'STDOUT' | 'STDERR' | 'PVE_TASK';
  at: string;
  content: string;
  truncated: boolean;
}

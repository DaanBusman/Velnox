import { JOB_TYPES, parseSelftestParams, type SelftestParams } from '@velnox/shared';

/**
 * Playbooks: what a job of a given type does, as a list of steps.
 *
 * docs/architecture.md section 9 calls for playbooks as data and steps from a
 * registry of small implementations, so that the PVE 8 → 9 upgrade and a future
 * PVE 9 → 10 upgrade are two lists over one set of steps rather than two large
 * functions. This is that shape at the size Phase 5 needs: one playbook, built
 * from its parameters. The upgrade phases add steps, not machinery.
 */

/** What a step gets while it runs. */
export interface StepContext {
  /**
   * Aborted when the job is cancelled. A step that can stop part-way — a wait,
   * a poll, a transfer — should pass it on; a step that must not be interrupted
   * ignores it and runs to completion, and cancellation is honoured at the next
   * boundary instead. Velnox never kills a dist-upgrade mid-transaction.
   */
  signal: AbortSignal;
  /** Report how far through this step is, 0–100. */
  progress(pct: number): Promise<void>;
  /** Raw output. Redacted and size-capped before it is stored. */
  log(stream: 'STDOUT' | 'STDERR', text: string): Promise<void>;
  /** Resolves after `ms`, or rejects with an AbortError when the job is cancelled. */
  sleep(ms: number): Promise<void>;
}

export interface TaskStep {
  kind: 'task';
  key: string;
  phase: string;
  run(context: StepContext): Promise<Record<string, string | number | boolean | null> | void>;
}

/**
 * A step that parks the job until someone decides.
 *
 * It does no work itself. Reaching it writes an approval row and moves the job
 * to WAITING_APPROVAL, and the worker lets go; approving puts the job back on the
 * queue, and the next run finds this step decided and moves past it.
 */
export interface ApprovalStep {
  kind: 'approval';
  key: string;
  phase: string;
  requiredPermission: string;
  reason: string;
  requireDifferentApprover: boolean;
  changeSet: Record<string, string | number | boolean | null>;
}

export type StepDefinition = TaskStep | ApprovalStep;

export interface Playbook {
  version: number;
  steps: StepDefinition[];
}

/** Thrown by a step to fail with a catalogue error code the interface can translate. */
export class StepError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'StepError';
  }
}

// ---------------------------------------------------------------------------
// system.selftest
// ---------------------------------------------------------------------------

/**
 * A job that does nothing but take time, and tells you about it.
 *
 * It exists to prove the machinery against a running installation — live
 * progress, cancellation between and within steps, failure, approval, and a
 * worker dying mid-job — without needing a cluster to change. Each step sleeps
 * in slices and reports progress per slice, so the stream has something to show
 * and cancellation has something to interrupt.
 */
export function selftestPlaybook(params: SelftestParams): Playbook {
  const steps: StepDefinition[] = [];

  for (let n = 1; n <= params.steps; n += 1) {
    if (params.approvalBeforeStep === n) {
      steps.push({
        kind: 'approval',
        key: `approve-before-${n}`,
        phase: 'work',
        requiredPermission: 'jobs.approve',
        reason: `Self-test approval gate before step ${n}`,
        requireDifferentApprover: params.requireDifferentApprover,
        changeSet: { step: n, of: params.steps },
      });
    }

    steps.push({
      kind: 'task',
      key: `step-${n}`,
      phase: 'work',
      run: async (context) => {
        const slices = 10;
        const sliceMs = Math.round((params.secondsPerStep * 1000) / slices);

        await context.log('STDOUT', `step ${n} of ${params.steps}: starting`);

        for (let slice = 1; slice <= slices; slice += 1) {
          await context.sleep(sliceMs);
          await context.progress(slice * 10);
        }

        if (params.failAtStep === n) {
          await context.log('STDERR', `step ${n}: failing on purpose, as asked`);
          throw new StepError('generic', `Self-test was asked to fail at step ${n}`);
        }

        await context.log('STDOUT', `step ${n} of ${params.steps}: done`);
        return { step: n };
      },
    });
  }

  return { version: 1, steps };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Job type to playbook.
 *
 * An unknown type is a thrown error, not a skipped job: it means the API and
 * the worker are different versions, and the job fails visibly with that as
 * its reason rather than succeeding at nothing.
 */
export function playbookFor(type: string, params: unknown): Playbook {
  switch (type) {
    case JOB_TYPES.selftest:
      return selftestPlaybook(parseSelftestParams(params));
    default:
      throw new StepError('generic', `No playbook for job type "${type}"`);
  }
}

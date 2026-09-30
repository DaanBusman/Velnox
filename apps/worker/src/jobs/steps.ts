import type { ErrorParams } from '@velnox/shared';

/**
 * The shape of a playbook and its steps.
 *
 * Its own module so that playbooks in other directories — the library's, from
 * Phase 5A — can use these without importing the registry that imports them.
 * A class in a module caught in an import cycle can be undefined at the moment
 * it is first used, and `instanceof StepError` then fails in ways that look like
 * something else entirely.
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
  /**
   * Undo what a job that did not finish left behind: a half-written file in the
   * library, a half-uploaded one on a node.
   *
   * Run by the runner when the job is cancelled or fails, **before** it records
   * the final state, so CANCELLED means "stopped and cleaned up" rather than
   * "stopped, and whatever it was doing is still lying around". Must be safe to
   * run when nothing was started, and must not throw for "already gone". A
   * cleanup that does throw is recorded as a warning on the job; the job still
   * ends.
   *
   * Not run for a job whose worker died — that worker's cleanup died with it.
   * The library's sweeper and Proxmox's own discarding of an interrupted upload
   * cover that case (ADR-037).
   */
  cleanup?(reason: 'cancelled' | 'failed'): Promise<void>;
}

/** Thrown by a step to fail with a catalogue error code the interface can translate. */
export class StepError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** The values the code's message needs. Never a secret. */
    readonly params?: ErrorParams,
  ) {
    super(message);
    this.name = 'StepError';
  }
}

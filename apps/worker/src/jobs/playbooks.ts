import { JOB_TYPES, parseSelftestParams, type SelftestParams } from '@velnox/shared';
import {
  clusterDeletePlaybook,
  fetchPlaybook,
  pullPlaybook,
  pushPlaybook,
  verifyPlaybook,
} from '../library/playbooks';
import type { LibraryServices } from '../library/services';
import { StepError, type Playbook, type StepDefinition } from './steps';

export { StepError } from './steps';
export type { ApprovalStep, Playbook, StepContext, StepDefinition, TaskStep } from './steps';

/**
 * Playbooks: what a job of a given type does, as a list of steps.
 *
 * docs/architecture.md section 9 calls for playbooks as data and steps from a
 * registry of small implementations, so that the PVE 8 → 9 upgrade and a future
 * PVE 9 → 10 upgrade are two lists over one set of steps rather than two large
 * functions. This is that shape at the size Phase 5 needs: one playbook, built
 * from its parameters. The upgrade phases add steps, not machinery.
 */

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
export interface PlaybookContext {
  jobId: string;
  tenantId: string;
  createdByUserId: string | null;
  /** Absent when the worker runs without a library — in tests of the self-test only. */
  library?: LibraryServices;
}

export function playbookFor(type: string, params: unknown, context: PlaybookContext): Playbook {
  const library = (): LibraryServices => {
    if (!context.library) throw new StepError('generic', `Job type "${type}" needs the library`);
    return context.library;
  };

  switch (type) {
    case JOB_TYPES.selftest:
      return selftestPlaybook(parseSelftestParams(params));
    case JOB_TYPES.libraryFetch:
      return fetchPlaybook(params, context.jobId, library());
    case JOB_TYPES.libraryVerify:
      return verifyPlaybook(params, context.jobId, library());
    case JOB_TYPES.libraryPush:
      return pushPlaybook(params, library());
    case JOB_TYPES.libraryPull:
      return pullPlaybook(params, context.jobId, library());
    case JOB_TYPES.libraryClusterDelete:
      return clusterDeletePlaybook(params, library());
    default:
      throw new StepError('generic', `No playbook for job type "${type}"`);
  }
}

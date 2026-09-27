import { describe, expect, it } from 'vitest';
import { JOB_TYPES, parseSelftestParams } from '@velnox/shared';
import { StepError, playbookFor, selftestPlaybook } from './playbooks';
import { abortableSleep } from './runner';
import { STALE_DISCOVERY_MS, lostJobWhere, staleDiscoveryWhere } from './reconcile';

const quiet = {
  signal: new AbortController().signal,
  progress: async () => undefined,
  log: async () => undefined,
  sleep: async () => undefined,
};

describe('self-test parameters', () => {
  it('fills in defaults for an empty request', () => {
    expect(parseSelftestParams({})).toEqual({
      steps: 5,
      secondsPerStep: 3,
      failAtStep: null,
      approvalBeforeStep: null,
      requireDifferentApprover: false,
    });
  });

  it('clamps rather than refusing, so the limits are the limits', () => {
    const parsed = parseSelftestParams({ steps: 500, secondsPerStep: 0 });
    expect(parsed.steps).toBe(20);
    expect(parsed.secondsPerStep).toBe(1);
  });

  it('drops a failure or gate step that is not one of the steps', () => {
    const parsed = parseSelftestParams({ steps: 3, failAtStep: 4, approvalBeforeStep: 0 });
    expect(parsed.failAtStep).toBeNull();
    expect(parsed.approvalBeforeStep).toBeNull();
  });

  it('ignores values of the wrong type', () => {
    const parsed = parseSelftestParams({ steps: '9', requireDifferentApprover: 'yes' });
    expect(parsed.steps).toBe(5);
    expect(parsed.requireDifferentApprover).toBe(false);
  });
});

describe('the self-test playbook', () => {
  it('has one task per step and unique keys', () => {
    const playbook = selftestPlaybook(parseSelftestParams({ steps: 4 }));
    expect(playbook.steps.map((step) => step.key)).toEqual(['step-1', 'step-2', 'step-3', 'step-4']);
  });

  it('puts the approval gate immediately before the step it guards', () => {
    const playbook = selftestPlaybook(parseSelftestParams({ steps: 3, approvalBeforeStep: 2 }));
    expect(playbook.steps.map((step) => `${step.kind}:${step.key}`)).toEqual([
      'task:step-1',
      'approval:approve-before-2',
      'task:step-2',
      'task:step-3',
    ]);
  });

  it('fails the step it was asked to fail, with a catalogue code', async () => {
    const playbook = selftestPlaybook(parseSelftestParams({ steps: 2, failAtStep: 2 }));
    const second = playbook.steps[1];
    if (second?.kind !== 'task') throw new Error('expected a task');
    await expect(second.run(quiet)).rejects.toBeInstanceOf(StepError);

    const first = playbook.steps[0];
    if (first?.kind !== 'task') throw new Error('expected a task');
    await expect(first.run(quiet)).resolves.toEqual({ step: 1 });
  });

  it('reports progress ten times per step, ending at 100', async () => {
    const reported: number[] = [];
    const playbook = selftestPlaybook(parseSelftestParams({ steps: 1 }));
    const step = playbook.steps[0];
    if (step?.kind !== 'task') throw new Error('expected a task');
    await step.run({ ...quiet, progress: async (pct) => void reported.push(pct) });
    expect(reported).toHaveLength(10);
    expect(reported.at(-1)).toBe(100);
  });

  it('refuses a job type it does not know', () => {
    // An API newer than the worker, or the reverse. Failing visibly is the point.
    expect(() => playbookFor('cluster.reformat', {})).toThrow(StepError);
    expect(() => playbookFor(JOB_TYPES.selftest, {})).not.toThrow();
  });
});

describe('abortableSleep', () => {
  it('resolves after the delay when nothing cancels it', async () => {
    await expect(abortableSleep(5, new AbortController().signal)).resolves.toBeUndefined();
  });

  it('rejects promptly when the job is cancelled mid-sleep', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const sleeping = abortableSleep(10_000, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await expect(sleeping).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('rejects at once when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(abortableSleep(10_000, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

describe('what counts as a lost job', () => {
  const now = new Date('2026-09-27T12:00:00.000Z');

  it('only considers states in which a worker holds the job', () => {
    const where = lostJobWhere(now);
    // QUEUED and WAITING_APPROVAL belong to nobody by design, so a missing
    // lease there is normal, not a sign of a dead worker.
    expect(where.status).toEqual({ in: ['PREFLIGHT', 'RUNNING', 'VALIDATING'] });
  });

  it('treats an absent or lapsed lease as lost, and a current one as held', () => {
    expect(lostJobWhere(now).OR).toEqual([{ leaseUntil: null }, { leaseUntil: { lt: now } }]);
  });
});

describe('what counts as a stale discovery run', () => {
  const now = new Date('2026-09-27T12:00:00.000Z');

  it('is a RUNNING run that started more than an hour ago', () => {
    expect(STALE_DISCOVERY_MS).toBe(3_600_000);
    expect(staleDiscoveryWhere(now)).toEqual({
      state: 'RUNNING',
      startedAt: { lt: new Date('2026-09-27T11:00:00.000Z') },
    });
  });
});


import { describe, expect, it } from 'vitest';
import { SELFTEST_CEPH_PLAYBOOK, SELFTEST_NODE_PLAYBOOK, playbookProblems } from '@velnox/shared';
import type { LibraryServices } from '../library/services';
import { knownActions, upgradePlaybook } from './engine';

const services = { prisma: {} } as unknown as LibraryServices;
const params = (playbookId: string, targets: string[]) => ({
  planId: 'p',
  clusterId: 'c',
  playbookId,
  playbookVersion: 1,
  targets: targets.map((label, i) => ({ id: `t${i}`, label })),
});

describe('upgradePlaybook', () => {
  it('every action a shipped playbook names exists in this worker', () => {
    expect(playbookProblems(SELFTEST_NODE_PLAYBOOK, knownActions())).toEqual([]);
    expect(playbookProblems(SELFTEST_CEPH_PLAYBOOK, knownActions())).toEqual([]);
  });

  it('turns the playbook into steps, per target where it says so', () => {
    const playbook = upgradePlaybook(
      params('velnox.selftest-nodes', ['pve1', 'pve2']),
      'j',
      services,
    );
    expect(playbook.steps.map((s) => s.key)).toEqual([
      'facts',
      'cluster-whole',
      'checks',
      'remediate-auto',
      'remediate-approve',
      'remediate-approved',
      'recheck',
      'gate',
      'node-1',
      'node-validate-1',
      'node-2',
      'node-validate-2',
      'report',
    ]);
    const gate = playbook.steps.find((s) => s.key === 'remediate-approve')!;
    expect(gate.kind).toBe('approval');
    expect(gate.when).toBeTypeOf('function');
  });

  it('refuses a playbook this worker does not have, or another version of it', () => {
    expect(() => upgradePlaybook(params('nope', ['pve1']), 'j', services)).toThrow(
      /No playbook nope/,
    );
    expect(() =>
      upgradePlaybook(
        { ...params('velnox.selftest-ceph', ['osd.0']), playbookVersion: 9 },
        'j',
        services,
      ),
    ).toThrow(/v9/);
  });
});

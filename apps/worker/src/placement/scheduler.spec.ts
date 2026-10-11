import { describe, expect, it } from 'vitest';
import { sameHaRule } from './scheduler';

describe('sameHaRule', () => {
  const want = {
    type: 'resource-affinity',
    affinity: 'negative',
    resources: 'ct:200,vm:101',
    comment: 'Managed by Velnox: db',
    disable: 0,
  };

  it('reads Proxmox’s answer as the same rule, whatever the order', () => {
    expect(
      sameHaRule(
        {
          rule: 'velnox-1',
          type: 'resource-affinity',
          affinity: 'negative',
          resources: 'vm:101,ct:200',
        },
        want,
      ),
    ).toBe(true);
  });

  it('sees a rule changed in Proxmox', () => {
    expect(
      sameHaRule(
        {
          rule: 'velnox-1',
          type: 'resource-affinity',
          affinity: 'positive',
          resources: 'vm:101,ct:200',
        },
        want,
      ),
    ).toBe(false);
    expect(
      sameHaRule(
        {
          rule: 'velnox-1',
          type: 'resource-affinity',
          affinity: 'negative',
          resources: 'vm:101,ct:200',
          disable: 1,
        },
        want,
      ),
    ).toBe(false);
  });

  it('compares a node preference by its nodes, priorities aside, and strictness', () => {
    const prefer = {
      type: 'node-affinity',
      resources: 'vm:100',
      nodes: 'pve1,pve2',
      strict: 1,
      disable: 0,
    };
    expect(
      sameHaRule(
        {
          rule: 'r',
          type: 'node-affinity',
          resources: 'vm:100',
          nodes: 'pve2:1,pve1:2',
          strict: 1,
        },
        prefer,
      ),
    ).toBe(true);
    expect(
      sameHaRule(
        { rule: 'r', type: 'node-affinity', resources: 'vm:100', nodes: 'pve1,pve2', strict: 0 },
        prefer,
      ),
    ).toBe(false);
  });
});

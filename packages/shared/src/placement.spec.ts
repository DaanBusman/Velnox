import { describe, expect, it } from 'vitest';
import {
  contradicts,
  hasHaRules,
  haRuleFor,
  placementForbids,
  placementViolations,
  planBalance,
  planCorrections,
  placementRuleSchema,
  type MovableGuest,
  type PlacementRuleLike,
} from './placement';

const GIB = 1024 ** 3;
const rule = (over: Partial<PlacementRuleLike>): PlacementRuleLike => ({
  id: 'r1',
  name: 'r1',
  kind: 'KEEP_APART',
  vmids: [],
  nodes: [],
  strict: true,
  enabled: true,
  ...over,
});
const guest = (
  vmid: number,
  node: string,
  gib = 4,
  blocker: string | null = null,
): MovableGuest => ({
  vmid,
  kind: 'qemu',
  node,
  memoryBytes: gib * GIB,
  blocker,
});
const at = (pairs: [number, string][]) => new Map(pairs);

describe('placementViolations', () => {
  it('finds two kept-apart guests on one node, and only running ones count', () => {
    const r = rule({ vmids: [100, 101, 102] });
    expect(
      placementViolations(
        [r],
        at([
          [100, 'pve1'],
          [101, 'pve1'],
        ]),
      ),
    ).toHaveLength(1);
    expect(
      placementViolations(
        [r],
        at([
          [100, 'pve1'],
          [102, 'pve2'],
        ]),
      ),
    ).toHaveLength(0);
  });

  it('finds kept-together guests apart, and a guest off its nodes (soft when not strict)', () => {
    const together = rule({ kind: 'KEEP_TOGETHER', vmids: [100, 101] });
    expect(
      placementViolations(
        [together],
        at([
          [100, 'pve1'],
          [101, 'pve2'],
        ]),
      ),
    ).toHaveLength(1);
    const prefer = rule({ kind: 'PREFER_NODES', vmids: [100], nodes: ['pve2'], strict: false });
    const [v] = placementViolations([prefer], at([[100, 'pve1']]));
    expect(v?.soft).toBe(true);
  });

  it('ignores a disabled rule', () => {
    expect(
      placementViolations(
        [rule({ vmids: [1, 2], enabled: false })],
        at([
          [1, 'a'],
          [2, 'a'],
        ]),
      ),
    ).toEqual([]);
  });
});

describe('placementForbids', () => {
  const apart = rule({ vmids: [100, 101] });
  it('keeps apart', () => {
    expect(placementForbids([apart], at([[101, 'pve2']]), 100, 'pve2')).toBe(apart);
    expect(placementForbids([apart], at([[101, 'pve2']]), 100, 'pve3')).toBeNull();
  });
  it('keeps together, wherever the first one went', () => {
    const together = rule({ kind: 'KEEP_TOGETHER', vmids: [100, 101] });
    expect(placementForbids([together], at([]), 100, 'pve3')).toBeNull();
    expect(placementForbids([together], at([[100, 'pve3']]), 101, 'pve2')).toBe(together);
  });
  it('a strict preference forbids other nodes; a soft one does not', () => {
    const strict = rule({ kind: 'PREFER_NODES', vmids: [100], nodes: ['pve1'] });
    expect(placementForbids([strict], at([]), 100, 'pve2')).toBe(strict);
    expect(placementForbids([{ ...strict, strict: false }], at([]), 100, 'pve2')).toBeNull();
  });
});

describe('planCorrections', () => {
  const free = new Map([
    ['pve1', 50 * GIB],
    ['pve2', 50 * GIB],
    ['pve3', 50 * GIB],
  ]);

  it('moves one of two kept-apart guests, to a node with neither', () => {
    const r = rule({ vmids: [100, 101, 102] });
    const { moves, unresolved } = planCorrections(
      [r],
      [guest(100, 'pve1'), guest(101, 'pve1', 2), guest(102, 'pve2')],
      free,
    );
    expect(unresolved).toEqual([]);
    expect(moves).toEqual([{ vmid: 101, kind: 'qemu', from: 'pve1', to: 'pve3', reason: 'r1' }]);
  });

  it('never fixes one rule by breaking another', () => {
    const apart = rule({ id: 'a', name: 'apart', vmids: [100, 101] });
    const prefer = rule({
      id: 'p',
      name: 'prefer',
      kind: 'PREFER_NODES',
      vmids: [101],
      nodes: ['pve1', 'pve2'],
    });
    const { moves } = planCorrections(
      [apart, prefer],
      [guest(100, 'pve1'), guest(101, 'pve1'), guest(200, 'pve2')],
      free,
    );
    expect(moves).toEqual([{ vmid: 101, kind: 'qemu', from: 'pve1', to: 'pve2', reason: 'apart' }]);
  });

  it('says what it cannot fix', () => {
    const r = rule({ vmids: [100, 101] });
    const tight = new Map([
      ['pve1', 50 * GIB],
      ['pve2', 1 * GIB],
    ]);
    expect(
      planCorrections([r], [guest(100, 'pve1'), guest(101, 'pve1')], tight).unresolved,
    ).toHaveLength(1);
    expect(
      planCorrections(
        [r],
        [guest(100, 'pve1', 4, 'disk on local'), guest(101, 'pve1', 4, 'x')],
        free,
      ).unresolved,
    ).toHaveLength(1);
  });

  it('brings kept-together guests to where most of them are', () => {
    const r = rule({ kind: 'KEEP_TOGETHER', vmids: [1, 2, 3] });
    const { moves } = planCorrections(
      [r],
      [guest(1, 'pve1'), guest(2, 'pve2'), guest(3, 'pve2')],
      free,
    );
    expect(moves).toEqual([{ vmid: 1, kind: 'qemu', from: 'pve1', to: 'pve2', reason: 'r1' }]);
  });

  it('a plan it makes holds the rule (property, random placements)', () => {
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let round = 0; round < 300; round += 1) {
      const nodes = ['a', 'b', 'c', 'd'].slice(0, 2 + rand(3));
      const guests = Array.from({ length: 2 + rand(6) }, (_, i) =>
        guest(100 + i, nodes[rand(nodes.length)]!, 1),
      );
      const vmids = guests.map((g) => g.vmid);
      const apart = rule({
        id: 'x',
        name: 'x',
        vmids: vmids.slice(0, Math.min(nodes.length, 2 + rand(3))),
      });
      const roomy = new Map(nodes.map((n) => [n, 100 * GIB]));
      const { moves, unresolved } = planCorrections([apart], guests, roomy);
      const after = new Map(guests.map((g) => [g.vmid, g.node]));
      for (const m of moves) after.set(m.vmid, m.to);
      expect(unresolved).toEqual([]);
      expect(placementViolations([apart], after)).toEqual([]);
    }
  });
});

describe('planBalance', () => {
  const nodes = [
    { node: 'pve1', totalBytes: 100 * GIB, usedBytes: 60 * GIB },
    { node: 'pve2', totalBytes: 100 * GIB, usedBytes: 20 * GIB },
  ];
  it('moves the smallest guest that narrows the spread', () => {
    const { move } = planBalance([], [guest(100, 'pve1', 30), guest(101, 'pve1', 8)], nodes, 10);
    expect(move).toMatchObject({ vmid: 101, from: 'pve1', to: 'pve2' });
  });
  it('moves nothing under the threshold, or against a rule', () => {
    expect(planBalance([], [guest(101, 'pve1', 8)], nodes, 50).move).toBeNull();
    const apart = rule({ vmids: [101, 200] });
    expect(
      planBalance([apart], [guest(101, 'pve1', 8), guest(200, 'pve2', 1)], nodes, 10).move,
    ).toBeNull();
  });
});

describe('requests and Proxmox', () => {
  it('refuses a rule between guests with one guest, and nodes on a keep-apart', () => {
    expect(
      placementRuleSchema.safeParse({ name: 'x', kind: 'KEEP_APART', vmids: [100] }).success,
    ).toBe(false);
    expect(
      placementRuleSchema.safeParse({
        name: 'x',
        kind: 'KEEP_APART',
        vmids: [100, 101],
        nodes: ['a'],
      }).success,
    ).toBe(false);
    expect(
      placementRuleSchema.safeParse({ name: 'x', kind: 'PREFER_NODES', vmids: [100], nodes: ['a'] })
        .success,
    ).toBe(true);
  });
  it('finds the same two guests kept apart and together', () => {
    expect(
      contradicts({ kind: 'KEEP_TOGETHER', vmids: [1, 2, 3] }, [
        rule({ name: 'apart', vmids: [2, 3] }),
      ]),
    ).toBe('apart');
  });
  it('writes Proxmox HA rules, and knows when they exist', () => {
    expect(
      haRuleFor({ ...rule({ name: 'db', vmids: [101, 200] }), kinds: { 101: 'qemu', 200: 'lxc' } }),
    ).toEqual({
      type: 'resource-affinity',
      affinity: 'negative',
      resources: 'ct:200,vm:101',
      comment: 'Managed by Velnox: db',
      disable: 0,
    });
    expect(hasHaRules(['9.0.6', '9.0.10'])).toBe(true);
    expect(hasHaRules(['9.0.6', '8.4.1'])).toBe(false);
    expect(hasHaRules(['pve-manager/9.0.3/abc'])).toBe(true);
  });
});

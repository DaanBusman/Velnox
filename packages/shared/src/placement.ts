import { z } from 'zod';

/**
 * Placement rules (Phase 7B): which guests may share a node, which must, and
 * which nodes a guest belongs on. Pure, so the API (what holds now), the worker
 * (which node a guest may go to) and the tests decide the same way.
 *
 * A rule names guests by VMID, which Proxmox keeps for a guest's life in its
 * cluster. Only running guests count: a stopped guest is nowhere.
 */

export const PLACEMENT_KINDS = ['KEEP_APART', 'KEEP_TOGETHER', 'PREFER_NODES'] as const;
export type PlacementKind = (typeof PLACEMENT_KINDS)[number];

export interface PlacementRuleLike {
  id: string;
  name: string;
  kind: PlacementKind;
  vmids: number[];
  /** PREFER_NODES only. */
  nodes: string[];
  /** PREFER_NODES only: only these nodes, never another. */
  strict: boolean;
  enabled: boolean;
}

/** Where each running guest is, or is about to be. */
export type Positions = Map<number, string>;

export interface PlacementViolation {
  ruleId: string;
  ruleName: string;
  kind: PlacementKind;
  /** A soft rule — a preference — not met. */
  soft: boolean;
  vmids: number[];
  message: string;
}

const label = (vmid: number) => `#${vmid}`;

/** Every rule not met by where the running guests are. */
export function placementViolations(
  rules: readonly PlacementRuleLike[],
  positions: Positions,
): PlacementViolation[] {
  const out: PlacementViolation[] = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const running = rule.vmids.filter((v) => positions.has(v));
    const base = { ruleId: rule.id, ruleName: rule.name, kind: rule.kind, soft: false };
    if (rule.kind === 'KEEP_APART') {
      const byNode = new Map<string, number[]>();
      for (const v of running) {
        const node = positions.get(v)!;
        byNode.set(node, [...(byNode.get(node) ?? []), v]);
      }
      for (const [node, vmids] of byNode) {
        if (vmids.length < 2) continue;
        out.push({
          ...base,
          vmids,
          message: `${vmids.map(label).join(', ')} share ${node}`,
        });
      }
    } else if (rule.kind === 'KEEP_TOGETHER') {
      const nodes = new Set(running.map((v) => positions.get(v)!));
      if (nodes.size > 1) {
        out.push({
          ...base,
          vmids: running,
          message: running.map((v) => `${label(v)} on ${positions.get(v)}`).join(', '),
        });
      }
    } else {
      const wanted = new Set(rule.nodes);
      const outside = running.filter((v) => !wanted.has(positions.get(v)!));
      if (outside.length) {
        out.push({
          ...base,
          soft: !rule.strict,
          vmids: outside,
          message: outside.map((v) => `${label(v)} on ${positions.get(v)}`).join(', '),
        });
      }
    }
  }
  return out;
}

/**
 * Whether a guest may go to a node, given where the others are. A guest about
 * to move is left out of `positions` by the caller, so it does not count
 * against itself. Returns the rule that forbids it, or null.
 */
export function placementForbids(
  rules: readonly PlacementRuleLike[],
  positions: Positions,
  vmid: number,
  node: string,
): PlacementRuleLike | null {
  for (const rule of rules) {
    if (!rule.enabled || !rule.vmids.includes(vmid)) continue;
    const others = rule.vmids.filter((v) => v !== vmid && positions.has(v));
    if (rule.kind === 'KEEP_APART') {
      if (others.some((v) => positions.get(v) === node)) return rule;
    } else if (rule.kind === 'KEEP_TOGETHER') {
      if (others.length && !others.some((v) => positions.get(v) === node)) return rule;
    } else if (rule.strict && !rule.nodes.includes(node)) {
      return rule;
    }
  }
  return null;
}

/** 0 for a node a soft preference names (or when there is none), 1 otherwise. */
export function placementRank(
  rules: readonly PlacementRuleLike[],
  vmid: number,
  node: string,
): number {
  const prefs = rules.filter(
    (r) => r.enabled && r.kind === 'PREFER_NODES' && r.vmids.includes(vmid),
  );
  if (!prefs.length) return 0;
  return prefs.every((r) => r.nodes.includes(node)) ? 0 : 1;
}

export interface MovableGuest {
  vmid: number;
  kind: 'qemu' | 'lxc';
  node: string;
  memoryBytes: number;
  /** Why it cannot move live, or null. */
  blocker: string | null;
}

export interface PlannedMove {
  vmid: number;
  kind: 'qemu' | 'lxc';
  from: string;
  to: string;
  /** The rule it serves, or `balance`. */
  reason: string;
}

/**
 * The best node for a guest: allowed by every rule, with room, preferred nodes
 * first, then the most free memory. `free` is updated when one is chosen.
 */
export function placeGuest(
  guest: MovableGuest,
  rules: readonly PlacementRuleLike[],
  positions: Positions,
  free: Map<string, number>,
  exclude: ReadonlySet<string>,
  only?: ReadonlySet<string>,
): string | null {
  let best: string | null = null;
  let bestRank = Infinity;
  for (const [node, bytes] of free) {
    if (exclude.has(node) || (only && !only.has(node)) || bytes < guest.memoryBytes) continue;
    if (placementForbids(rules, positions, guest.vmid, node)) continue;
    const rank = placementRank(rules, guest.vmid, node);
    if (rank < bestRank || (rank === bestRank && bytes > free.get(best!)!)) {
      best = node;
      bestRank = rank;
    }
  }
  if (best) free.set(best, free.get(best)! - guest.memoryBytes);
  return best;
}

/**
 * The moves that bring the guests back within the rules without breaking
 * another, hard rules first. What cannot be fixed — no room, a guest that
 * cannot move live, a rule that cannot be met — is said, not forced.
 */
export function planCorrections(
  rules: readonly PlacementRuleLike[],
  guests: readonly MovableGuest[],
  freeMemory: ReadonlyMap<string, number>,
): { moves: PlannedMove[]; unresolved: string[] } {
  const positions: Positions = new Map(guests.map((g) => [g.vmid, g.node]));
  const byVmid = new Map(guests.map((g) => [g.vmid, g]));
  const free = new Map(freeMemory);
  const moves: PlannedMove[] = [];
  const unresolved: string[] = [];

  const move = (guest: MovableGuest, rule: PlacementRuleLike, only?: ReadonlySet<string>) => {
    const from = positions.get(guest.vmid)!;
    if (guest.blocker) {
      unresolved.push(`#${guest.vmid} cannot move live (${guest.blocker}) — rule "${rule.name}"`);
      return false;
    }
    positions.delete(guest.vmid);
    const to = placeGuest(guest, rules, positions, free, new Set([from]), only);
    if (!to) {
      positions.set(guest.vmid, from);
      unresolved.push(`no node can take #${guest.vmid} within the rules — rule "${rule.name}"`);
      return false;
    }
    positions.set(guest.vmid, to);
    free.set(from, (free.get(from) ?? 0) + guest.memoryBytes);
    const earlier = moves.find((m) => m.vmid === guest.vmid);
    if (earlier) earlier.to = to;
    else moves.push({ vmid: guest.vmid, kind: guest.kind, from, to, reason: rule.name });
    return true;
  };

  const order: Record<PlacementKind, number> = { KEEP_APART: 0, KEEP_TOGETHER: 1, PREFER_NODES: 2 };
  const sorted = rules
    .filter((r) => r.enabled)
    .slice()
    .sort((a, b) => order[a.kind] - order[b.kind] || Number(b.strict) - Number(a.strict));

  for (const rule of sorted) {
    const running = rule.vmids.filter((v) => positions.has(v) && byVmid.has(v));
    if (rule.kind === 'KEEP_APART') {
      const byNode = new Map<string, number[]>();
      for (const v of running) {
        const node = positions.get(v)!;
        byNode.set(node, [...(byNode.get(node) ?? []), v]);
      }
      for (const vmids of byNode.values()) {
        // The first stays; the others go — the smallest first, so the most fit.
        const extra = vmids
          .slice(1)
          .map((v) => byVmid.get(v)!)
          .sort((a, b) => a.memoryBytes - b.memoryBytes);
        for (const guest of extra) move(guest, rule);
      }
    } else if (rule.kind === 'KEEP_TOGETHER') {
      const count = new Map<string, number>();
      for (const v of running)
        count.set(positions.get(v)!, (count.get(positions.get(v)!) ?? 0) + 1);
      if (count.size < 2) continue;
      const target = [...count.entries()].sort(
        (a, b) => b[1] - a[1] || (free.get(b[0]) ?? 0) - (free.get(a[0]) ?? 0),
      )[0]![0];
      for (const v of running) {
        if (positions.get(v) === target) continue;
        move(byVmid.get(v)!, rule, new Set([target]));
      }
    } else {
      const wanted = new Set(rule.nodes);
      for (const v of running) {
        if (wanted.has(positions.get(v)!)) continue;
        move(byVmid.get(v)!, rule, wanted);
      }
    }
  }
  return { moves: moves.filter((m) => m.from !== m.to), unresolved };
}

export interface NodeLoad {
  node: string;
  totalBytes: number;
  usedBytes: number;
}

const spread = (loads: Map<string, NodeLoad>) => {
  const pct = [...loads.values()].map((l) =>
    l.totalBytes ? (l.usedBytes / l.totalBytes) * 100 : 0,
  );
  return Math.max(...pct) - Math.min(...pct);
};

/**
 * One move that evens out memory use across the nodes, when the busiest and
 * the quietest differ by more than `thresholdPercent` points — never against
 * a rule, never one that leaves the spread no smaller.
 */
export function planBalance(
  rules: readonly PlacementRuleLike[],
  guests: readonly MovableGuest[],
  nodes: readonly NodeLoad[],
  thresholdPercent: number,
): { move: PlannedMove | null; spreadPercent: number } {
  const loads = new Map(nodes.map((n) => [n.node, { ...n }]));
  const before = loads.size > 1 ? spread(loads) : 0;
  if (loads.size < 2 || before <= thresholdPercent) return { move: null, spreadPercent: before };
  const pct = (l: NodeLoad) => (l.totalBytes ? l.usedBytes / l.totalBytes : 0);
  const busiest = [...loads.values()].sort((a, b) => pct(b) - pct(a))[0]!;
  const positions: Positions = new Map(guests.map((g) => [g.vmid, g.node]));
  const candidates = guests
    .filter((g) => g.node === busiest.node && !g.blocker)
    .sort((a, b) => a.memoryBytes - b.memoryBytes);
  const targets = [...loads.values()]
    .filter((l) => l.node !== busiest.node)
    .sort((a, b) => pct(a) - pct(b));
  for (const guest of candidates) {
    positions.delete(guest.vmid);
    for (const target of targets) {
      if (target.totalBytes - target.usedBytes < guest.memoryBytes) continue;
      if (placementForbids(rules, positions, guest.vmid, target.node)) continue;
      if (
        placementRank(rules, guest.vmid, target.node) > placementRank(rules, guest.vmid, guest.node)
      )
        continue;
      const trial = new Map([...loads].map(([k, v]) => [k, { ...v }]));
      trial.get(busiest.node)!.usedBytes -= guest.memoryBytes;
      trial.get(target.node)!.usedBytes += guest.memoryBytes;
      if (spread(trial) < before) {
        return {
          move: {
            vmid: guest.vmid,
            kind: guest.kind,
            from: guest.node,
            to: target.node,
            reason: 'balance',
          },
          spreadPercent: before,
        };
      }
    }
    positions.set(guest.vmid, guest.node);
  }
  return { move: null, spreadPercent: before };
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const placementRuleSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    kind: z.enum(PLACEMENT_KINDS),
    vmids: z.array(z.number().int().min(100).max(999_999_999)).min(1).max(50),
    nodes: z.array(z.string().trim().min(1).max(63)).max(32).default([]),
    strict: z.boolean().default(true),
    enabled: z.boolean().default(true),
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (new Set(rule.vmids).size !== rule.vmids.length)
      ctx.addIssue({ code: 'custom', path: ['vmids'], message: 'A guest is named twice' });
    if (rule.kind !== 'PREFER_NODES' && rule.vmids.length < 2)
      ctx.addIssue({ code: 'custom', path: ['vmids'], message: 'A rule between guests needs two' });
    if (rule.kind === 'PREFER_NODES' && rule.nodes.length < 1)
      ctx.addIssue({ code: 'custom', path: ['nodes'], message: 'Name at least one node' });
    if (rule.kind !== 'PREFER_NODES' && rule.nodes.length)
      ctx.addIssue({
        code: 'custom',
        path: ['nodes'],
        message: 'Only a node preference names nodes',
      });
  });
export type PlacementRuleInput = z.infer<typeof placementRuleSchema>;

export const placementSettingsSchema = z
  .object({
    autoCorrect: z.boolean(),
    balance: z.boolean(),
    balanceThresholdPercent: z.number().int().min(5).max(80),
    quietMinutes: z.number().int().min(5).max(1440),
  })
  .strict();
export type PlacementSettingsInput = z.infer<typeof placementSettingsSchema>;

export const PLACEMENT_REASONS = ['correct', 'balance'] as const;
export type PlacementReason = (typeof PLACEMENT_REASONS)[number];

export interface PlacementJobParams {
  clusterId: string;
  reason: PlacementReason;
  /** Who asked, when it was not a person: `placement settings`. */
  by: string | null;
  balanceThresholdPercent: number;
}

/**
 * Two rules that cannot both hold: the same two guests kept apart by one and
 * together by the other. Returns the other rule's name.
 */
export function contradicts(
  rule: Pick<PlacementRuleLike, 'kind' | 'vmids'>,
  others: readonly PlacementRuleLike[],
): string | null {
  if (rule.kind === 'PREFER_NODES') return null;
  const opposite = rule.kind === 'KEEP_APART' ? 'KEEP_TOGETHER' : 'KEEP_APART';
  for (const other of others) {
    if (other.kind !== opposite || !other.enabled) continue;
    const shared = other.vmids.filter((v) => rule.vmids.includes(v));
    if (shared.length >= 2) return other.name;
  }
  return null;
}

/** Proxmox's HA rule for a Velnox rule (PVE 9). */
export function haRuleFor(
  rule: PlacementRuleLike & { kinds: Record<number, 'qemu' | 'lxc'> },
): Record<string, string | number> {
  const resources = rule.vmids
    .map((v) => `${rule.kinds[v] === 'lxc' ? 'ct' : 'vm'}:${v}`)
    .sort()
    .join(',');
  const common = {
    resources,
    comment: `Managed by Velnox: ${rule.name}`,
    disable: rule.enabled ? 0 : 1,
  };
  if (rule.kind === 'PREFER_NODES') {
    return {
      ...common,
      type: 'node-affinity',
      nodes: rule.nodes.slice().sort().join(','),
      strict: rule.strict ? 1 : 0,
    };
  }
  return {
    ...common,
    type: 'resource-affinity',
    affinity: rule.kind === 'KEEP_APART' ? 'negative' : 'positive',
  };
}

/** Velnox's id for a rule in Proxmox's HA rules. */
export const haRuleId = (ruleId: string) => `velnox-${ruleId.slice(0, 8)}`;

/** Whether every node runs PVE 9 or later, where Proxmox's HA rules exist. */
export function hasHaRules(pveVersions: readonly string[]): boolean {
  if (!pveVersions.length) return false;
  return pveVersions.every((v) => {
    const match = /(\d+)\.\d+/.exec(v);
    return match ? Number(match[1]) >= 9 : false;
  });
}

// ---------------------------------------------------------------------------
// What the screen reads
// ---------------------------------------------------------------------------

export type PlacementHaState = 'synced' | 'pending' | 'error' | 'velnox';

export interface PlacementRuleView {
  id: string;
  name: string;
  kind: PlacementKind;
  vmids: number[];
  nodes: string[];
  strict: boolean;
  enabled: boolean;
  violations: PlacementViolation[];
  /** On PVE 9: whether Proxmox's HA rules hold it. `velnox` on PVE 8. */
  ha: {
    state: PlacementHaState;
    ruleId: string | null;
    syncedAt: string | null;
    error: string | null;
  };
  createdBy: string | null;
  updatedAt: string;
}

export interface PlacementClusterView {
  cluster: {
    id: string;
    name: string;
    tenantId: string;
    pveVersions: string[];
    haRules: boolean;
    whole: boolean;
  };
  rules: PlacementRuleView[];
  settings: PlacementSettingsInput;
  guests: {
    vmid: number;
    kind: 'qemu' | 'lxc';
    name: string | null;
    node: string | null;
    running: boolean;
  }[];
  nodes: { name: string; online: boolean; memoryUsedPercent: number | null }[];
  jobs: {
    id: string;
    status: string;
    reason: PlacementReason | null;
    queuedAt: string;
    by: string | null;
  }[];
  canManage: boolean;
}

export const DEFAULT_PLACEMENT_SETTINGS: PlacementSettingsInput = {
  autoCorrect: false,
  balance: false,
  balanceThresholdPercent: 20,
  quietMinutes: 30,
};

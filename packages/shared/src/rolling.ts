import { z } from 'zod';
import { REBOOT_POLICIES, maxUnavailableNodes, type RebootPolicy } from './updates';

/**
 * Rolling updates (Phase 7): a whole cluster, node after node, guests moved
 * away first, the cluster never short of quorum.
 *
 * The plan is decided once, when the job is created: which nodes, in which
 * groups. A group is the nodes taken down together; by default one. The
 * central safety invariant (docs/architecture.md, section 9) is enforced here
 * and nowhere else needs to re-derive it: at no point may the number of
 * unavailable quorum-voting nodes exceed ⌊(n − 1) / 2⌋, counting the nodes
 * already down when the run starts.
 */

export class PlanRefused extends Error {
  constructor(
    readonly reason: 'no_nodes' | 'would_lose_quorum',
    message: string,
  ) {
    super(message);
    this.name = 'PlanRefused';
  }
}

/**
 * Split the nodes to update into groups that keep quorum.
 *
 * `votingNodes` is the cluster's size; `alreadyDown` how many of its voting
 * nodes are down before anything starts. A standalone node (one voter) has no
 * quorum to keep and is its own group. A group never exceeds `concurrency`,
 * and never exceeds what quorum allows on top of what is already down.
 */
export function planRollingGroups(input: {
  nodes: string[];
  votingNodes: number;
  concurrency: number;
  alreadyDown: number;
}): string[][] {
  const nodes = [...new Set(input.nodes)];
  if (nodes.length === 0) throw new PlanRefused('no_nodes', 'There is no node to update');
  const allowed =
    input.votingNodes <= 1 ? 1 : maxUnavailableNodes(input.votingNodes) - input.alreadyDown;
  if (allowed < 1) {
    throw new PlanRefused(
      'would_lose_quorum',
      input.votingNodes === 2
        ? 'A two-node cluster loses quorum when either node goes down; it cannot be updated node by node without a quorum device'
        : `Taking a node down would leave ${input.votingNodes - input.alreadyDown - 1} of ${input.votingNodes} nodes, short of quorum`,
    );
  }
  const size = Math.max(1, Math.min(Math.floor(input.concurrency), allowed));
  const groups: string[][] = [];
  for (let i = 0; i < nodes.length; i += size) groups.push(nodes.slice(i, i + size));
  return groups;
}

export const NON_MIGRATABLE_POLICIES = ['BLOCK', 'SHUTDOWN'] as const;
export type NonMigratablePolicy = (typeof NON_MIGRATABLE_POLICIES)[number];

export const rollingUpdateRequestSchema = z.object({
  /** How many nodes may be taken down together. Capped by quorum. */
  concurrency: z.number().int().min(1).max(15).default(1),
  rebootPolicy: z.enum(REBOOT_POLICIES).default('IF_REQUIRED'),
  /**
   * A running guest that cannot be live-migrated — a disk on a node's own
   * storage, a passed-through device — either stops the run before it starts
   * (`BLOCK`), or is shut down for its node's reboot and started again after
   * (`SHUTDOWN`).
   */
  nonMigratable: z.enum(NON_MIGRATABLE_POLICIES).default('BLOCK'),
  /** Move each guest back to the node it came from once that node is done. */
  migrateBack: z.boolean().default(true),
  /** How long a node, the cluster and Ceph may take to come back whole after a reboot. */
  settleMinutes: z.number().int().min(1).max(60).default(10),
  /** Only these nodes; all of the cluster's nodes when absent. */
  nodes: z
    .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/))
    .max(64)
    .optional(),
});
export type RollingUpdateRequest = z.infer<typeof rollingUpdateRequestSchema>;

export interface RollingUpdateParams {
  clusterId: string;
  /** In the order they are updated. */
  groups: string[][];
  nodeIds: Record<string, string>;
  rebootPolicy: RebootPolicy;
  nonMigratable: NonMigratablePolicy;
  migrateBack: boolean;
  requireApproval: boolean;
  maintenanceWindowId: string | null;
  policyId: string | null;
  settleMinutes: number;
}

/** One running guest as the plan sees it. */
export interface PlannedGuest {
  vmid: number;
  kind: 'qemu' | 'lxc';
  name: string | null;
  node: string;
  memoryBytes: number;
  /** Why it cannot be live-migrated; null when it can. */
  blocker: string | null;
}

/** What a rolling update would do, before it is started. */
export interface RollingPlanPreview {
  clusterId: string;
  clusterName: string;
  groups: string[][];
  /** Why the plan cannot run, as a catalogue code with its parameters; null when it can. */
  refused: { code: string; params: Record<string, string | number> } | null;
  guests: PlannedGuest[];
  nonMigratable: PlannedGuest[];
  /** Nodes whose guests would not fit on the others while it is down. */
  capacityShort: { node: string; neededBytes: number; freeBytes: number }[];
  maxConcurrency: number;
}

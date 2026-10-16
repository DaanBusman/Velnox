import { z } from 'zod';

/**
 * Merging two registrations of one Proxmox cluster (ADR-055).
 *
 * Two standalone servers added to Velnox one by one, and joined into one
 * Proxmox cluster afterwards (`pvecm create` on one, `pvecm add` on the
 * other), each still have their own registration — both now reporting the
 * same cluster. Velnox does not join anything itself; it notices, and merges
 * its own records: one registration stays, renamed, and what the other held
 * comes with it.
 */

/** Two registrations Velnox reads as one Proxmox cluster. */
export interface ClusterMergeCandidate {
  /** The name Proxmox gives the cluster: the name the merged one is offered. */
  pveClusterName: string;
  clusters: {
    id: string;
    name: string;
    endpoint: string;
    sshConfigured: boolean;
    siteId: string | null;
  }[];
  /** The nodes both report. */
  nodes: string[];
}

export interface ClusterLike {
  id: string;
  tenantId: string;
  pveClusterName: string | null;
  nodes: readonly string[];
}

/**
 * Whether two registrations are one Proxmox cluster: the same tenant, the
 * same name from Proxmox, and nodes in common. A shared node name alone is not
 * enough — two unrelated standalone servers are both called `pve` more often
 * than not, and neither reports a cluster name.
 */
export function sameProxmoxCluster(a: ClusterLike, b: ClusterLike): boolean {
  if (a.id === b.id || a.tenantId !== b.tenantId) return false;
  if (!a.pveClusterName || a.pveClusterName !== b.pveClusterName) return false;
  const nodes = new Set(a.nodes);
  return b.nodes.some((node) => nodes.has(node));
}

/** Every pair of registrations that are one cluster, grouped by that cluster. */
export function mergeCandidates<T extends ClusterLike>(clusters: readonly T[]): T[][] {
  const groups: T[][] = [];
  for (const cluster of clusters) {
    const group = groups.find((g) => g.some((other) => sameProxmoxCluster(cluster, other)));
    if (group) group.push(cluster);
    else if (clusters.some((other) => sameProxmoxCluster(cluster, other))) groups.push([cluster]);
  }
  return groups;
}

export const clusterMergeSchema = z
  .object({
    /** The registration that stays: its connection to Proxmox is the one kept. */
    keepId: z.string().uuid(),
    /** The one that goes, after what it holds has moved over. */
    removeId: z.string().uuid(),
    /** The merged cluster's name in Velnox. */
    name: z.string().trim().min(1).max(100),
    /** Whose SSH set-up to keep when both have one. */
    sshFrom: z.enum(['keep', 'remove']).default('keep'),
  })
  .strict();
export type ClusterMergeInput = z.infer<typeof clusterMergeSchema>;

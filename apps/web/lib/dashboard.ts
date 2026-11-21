import type { ClusterSummary, NodeSummary, StorageRow } from '@/lib/session-types';

/**
 * What the dashboard works out from the inventory. Pure, so the arithmetic is
 * tested on its own: a capacity figure that counts a shared storage once per
 * node reads as if there were several times the disk there is.
 */

export interface ClusterCapacity {
  id: string;
  name: string;
  /** Each 0–1. Null when there is no figure, which is not the same as nothing used. */
  cpu: number | null;
  memory: number | null;
  storage: number | null;
  /** The last reading failed, so these are the figures from before that. */
  stale: boolean;
  lastSeenAt: string | null;
}

/** Byte counts arrive as strings, because they can exceed what a JSON number holds. */
const bytes = (value: string | null | undefined): bigint | null =>
  value !== null && value !== undefined && /^\d+$/.test(value) ? BigInt(value) : null;

const ratio = (used: bigint, total: bigint): number | null =>
  total > 0n ? Number((used * 10_000n) / total) / 10_000 : null;

/**
 * Each storage once: a shared one is the same disk on every node that lists it,
 * a local one is a different disk on each. Disabled or inactive ones report
 * nothing that can be relied on and are left out.
 */
export function distinctStorages(storages: readonly StorageRow[]): StorageRow[] {
  const seen = new Set<string>();
  return storages.filter((storage) => {
    if (!storage.enabled || !storage.active) return false;
    const key = storage.shared
      ? `${storage.clusterId}:${storage.name}`
      : `${storage.clusterId}:${storage.nodeId}:${storage.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** How full each cluster is, the fullest first. */
export function capacityByCluster(
  clusters: readonly ClusterSummary[],
  nodes: readonly NodeSummary[],
  storages: readonly StorageRow[],
): ClusterCapacity[] {
  const distinct = distinctStorages(storages);
  const rows = clusters.map((cluster): ClusterCapacity => {
    // An offline node's last figures say nothing about now.
    const online = nodes.filter((n) => n.clusterId === cluster.id && n.state === 'ONLINE');

    let cores = 0;
    let busy = 0;
    let memoryUsed = 0n;
    let memoryTotal = 0n;
    for (const node of online) {
      if (node.cpuUsage !== null && node.cpuCount) {
        cores += node.cpuCount;
        busy += node.cpuUsage * node.cpuCount;
      }
      const used = bytes(node.memoryUsedBytes);
      const total = bytes(node.memoryTotalBytes);
      if (used !== null && total !== null) {
        memoryUsed += used;
        memoryTotal += total;
      }
    }

    let storageUsed = 0n;
    let storageTotal = 0n;
    for (const storage of distinct) {
      if (storage.clusterId !== cluster.id) continue;
      const used = bytes(storage.usedBytes);
      const total = bytes(storage.totalBytes);
      if (used !== null && total !== null) {
        storageUsed += used;
        storageTotal += total;
      }
    }

    return {
      id: cluster.id,
      name: cluster.name,
      cpu: cores > 0 ? Math.min(busy / cores, 1) : null,
      memory: ratio(memoryUsed, memoryTotal),
      storage: ratio(storageUsed, storageTotal),
      stale: cluster.connectionState !== 'CONNECTED',
      lastSeenAt: cluster.lastSeenAt,
    };
  });
  const fullest = (row: ClusterCapacity) => Math.max(row.cpu ?? -1, row.memory ?? -1, row.storage ?? -1);
  return rows.sort((a, b) => fullest(b) - fullest(a) || a.name.localeCompare(b.name));
}

/** Storages at or past this share used are worth someone's attention. */
export const STORAGE_FULL_AT = 0.9;

export function fullStorages(storages: readonly StorageRow[]): StorageRow[] {
  return distinctStorages(storages).filter((storage) => {
    const used = bytes(storage.usedBytes);
    const total = bytes(storage.totalBytes);
    if (used === null || total === null) return false;
    const share = ratio(used, total);
    return share !== null && share >= STORAGE_FULL_AT;
  });
}

export interface UpdateSplit {
  current: number;
  pending: number;
  /** Not checked yet. Never counted as up to date. */
  unknown: number;
  /** The nodes with the most updates waiting. */
  most: NodeSummary[];
}

export function updateSplit(nodes: readonly NodeSummary[], listed = 4): UpdateSplit {
  const pending = nodes.filter((n) => (n.updatesAvailable ?? 0) > 0);
  return {
    current: nodes.filter((n) => n.updatesAvailable === 0).length,
    pending: pending.length,
    unknown: nodes.filter((n) => n.updatesAvailable === null).length,
    most: [...pending]
      .sort(
        (a, b) => (b.updatesAvailable ?? 0) - (a.updatesAvailable ?? 0) || a.name.localeCompare(b.name),
      )
      .slice(0, listed),
  };
}

/**
 * The top of a chart's axis: a round number at or above the highest value, close
 * enough that the bars use the plot, and even, because the axis also marks half.
 */
export function niceMax(value: number): number {
  if (value <= 4) return 4;
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((candidate) => {
    const top = Math.round(candidate * power);
    return top >= value && top % 2 === 0;
  });
  return Math.round((step ?? 10) * power);
}

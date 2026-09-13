import type { VelnoxPrismaClient } from '@velnox/db';
import type { DiscoveredCluster, DiscoveredNode, DiscoveredWorkload } from '@velnox/proxmox';

/**
 * Writing an inventory run down.
 *
 * Upsert and prune, not delete and re-insert. The row ids are what grants, jobs
 * and — from phase 5 — running work point at, so recreating them on every
 * discovery would invalidate every reference twice an hour. A node that is still
 * there keeps the id it had.
 *
 * What disappeared is removed at the end, and only for the resources this run
 * actually managed to read. A run that could not reach a node must not conclude
 * that its guests have been deleted — that is the difference between stale
 * inventory and an inventory that lies.
 */

/** Proxmox's status strings, mapped to the states Velnox stores. */
export function workloadState(status: string | null): 'RUNNING' | 'STOPPED' | 'PAUSED' | 'UNKNOWN' {
  switch (status) {
    case 'running':
      return 'RUNNING';
    case 'stopped':
      return 'STOPPED';
    case 'paused':
    case 'suspended':
      return 'PAUSED';
    default:
      // Anything unrecognised stays UNKNOWN, and `rawStatus` keeps what it
      // actually said — a new Proxmox state should be visible, not flattened.
      return 'UNKNOWN';
  }
}

/**
 * A cluster's health, from what was discovered.
 *
 * Deliberately blunt, and deliberately pessimistic about the unknown. It is not
 * a summary of every possible problem; it is the one-word answer a list column
 * needs, and anything it is unsure about reads as UNKNOWN rather than OK.
 */
export function clusterHealth(
  discovered: DiscoveredCluster,
): 'OK' | 'WARNING' | 'CRITICAL' | 'UNKNOWN' {
  const offline = discovered.nodes.filter((node) => node.state !== 'online').length;

  if (discovered.nodes.length === 0) return 'UNKNOWN';
  if (!discovered.standalone && discovered.quorate === false) return 'CRITICAL';
  if (discovered.ceph?.healthStatus === 'HEALTH_ERR') return 'CRITICAL';
  if (offline > 0) return 'WARNING';
  if (discovered.ceph && discovered.ceph.healthStatus !== 'HEALTH_OK') return 'WARNING';
  // A cluster part-way through an upgrade is not broken, and is not fine either.
  if (discovered.pveVersions.length > 1) return 'WARNING';
  if (discovered.ceph?.flags.length) return 'WARNING';
  if (discovered.problems.length > 0) return 'WARNING';

  return 'OK';
}

export const nodeHealth = (node: DiscoveredNode): 'OK' | 'WARNING' | 'CRITICAL' | 'UNKNOWN' => {
  if (node.state === 'offline') return 'CRITICAL';
  if (node.state === 'unknown') return 'UNKNOWN';
  if (node.problems.length > 0) return 'WARNING';
  return 'OK';
};

const big = (value: number | null): bigint | null =>
  value === null ? null : BigInt(Math.round(value));

/** Seconds as an integer, because Proxmox sometimes sends a float. */
const seconds = (value: number | null): number | null =>
  value === null ? null : Math.round(value);

export interface PersistResult {
  nodesSeen: number;
  workloadsSeen: number;
  cephDaemonsSeen: number;
}

export async function persistDiscovery(
  prisma: VelnoxPrismaClient,
  cluster: { id: string; tenantId: string },
  discovered: DiscoveredCluster,
): Promise<PersistResult> {
  const now = new Date();

  // --- the cluster itself ---------------------------------------------------
  await prisma.cluster.update({
    where: { id: cluster.id },
    data: {
      kind: discovered.standalone ? 'STANDALONE' : 'CLUSTER',
      // The name is deliberately not written. Proxmox has one and so does
      // Velnox, and the operator's is the one they typed — overwriting it on
      // every discovery run would undo their rename twice an hour.
      connectionState: 'CONNECTED',
      health: clusterHealth(discovered),
      pveVersion: discovered.version,
      pveVersions: discovered.pveVersions,
      quorate: discovered.quorate,
      nodeCount: discovered.nodes.length,
      cephPresent: discovered.ceph !== null,
      cephHealth: discovered.ceph?.healthStatus ?? null,
      cephHealthDetail: discovered.ceph?.healthChecks ?? [],
      cephVersions: discovered.ceph?.versions ?? [],
      cephVersionsHomogeneous: discovered.ceph?.versionsHomogeneous ?? null,
      cephOsdsTotal: discovered.ceph?.osdTotal ?? null,
      cephOsdsUp: discovered.ceph?.osdUp ?? null,
      cephOsdsIn: discovered.ceph?.osdIn ?? null,
      cephPgsTotal: discovered.ceph?.pgTotal ?? null,
      cephPgsClean: discovered.ceph?.pgsClean ?? null,
      cephMonQuorum: discovered.ceph?.monInQuorum ?? null,
      cephMonTotal: discovered.ceph?.monTotal ?? null,
      cephFlags: discovered.ceph?.flags ?? [],
      lastSeenAt: now,
      lastDiscoveryAt: now,
      lastErrorCode: null,
      lastErrorDetail: null,
    },
  });

  // --- nodes ----------------------------------------------------------------
  const nodeIdByName = new Map<string, string>();

  for (const node of discovered.nodes) {
    const data = {
      tenantId: cluster.tenantId,
      nodeId: node.nodeId,
      address: node.ip,
      state: node.state === 'online' ? 'ONLINE' : node.state === 'offline' ? 'OFFLINE' : 'UNKNOWN',
      health: nodeHealth(node),
      pveVersion: node.pveVersion,
      kernelVersion: node.kernelVersion,
      subscriptionStatus: node.subscriptionStatus,
      subscriptionLevel: node.subscriptionLevel,
      cpuCount: node.cpuCount,
      cpuModel: node.cpuModel,
      cpuUsage: node.cpuUsage,
      memoryTotalBytes: big(node.memoryTotalBytes),
      memoryUsedBytes: big(node.memoryUsedBytes),
      rootfsTotalBytes: big(node.rootfsTotalBytes),
      rootfsUsedBytes: big(node.rootfsUsedBytes),
      uptimeSeconds: seconds(node.uptimeSeconds),
      updatesAvailable: node.pendingUpdateCount,
      repositories: node.repositories,
      problems: node.problems,
      lastSeenAt: now,
    } as const;

    const row = await prisma.node.upsert({
      where: { clusterId_name: { clusterId: cluster.id, name: node.name } },
      create: { clusterId: cluster.id, name: node.name, ...data },
      update: data,
    });

    nodeIdByName.set(node.name, row.id);

    /*
     * Storage and interfaces are replaced rather than upserted.
     *
     * Nothing points at them — they are leaves — and a node that lost an
     * interface should lose the row. The tenancy extension filters the delete to
     * this tenant like everything else, and the node id it is keyed on came from
     * a scoped query a moment ago.
     */
    if (node.storages.length > 0 || node.state === 'online') {
      await prisma.nodeStorage.deleteMany({ where: { nodeId: row.id } });
      if (node.storages.length > 0) {
        await prisma.nodeStorage.createMany({
          data: node.storages.map((storage) => ({
            tenantId: cluster.tenantId,
            nodeId: row.id,
            name: storage.name,
            type: storage.type,
            enabled: storage.enabled,
            active: storage.active,
            shared: storage.shared,
            content: storage.content,
            totalBytes: big(storage.totalBytes),
            usedBytes: big(storage.usedBytes),
            availableBytes: big(storage.availableBytes),
          })),
        });
      }
    }

    if (node.interfaces.length > 0 || node.state === 'online') {
      await prisma.nodeInterface.deleteMany({ where: { nodeId: row.id } });
      if (node.interfaces.length > 0) {
        await prisma.nodeInterface.createMany({
          data: node.interfaces.map((entry) => ({
            tenantId: cluster.tenantId,
            nodeId: row.id,
            name: entry.name,
            type: entry.type,
            active: entry.active,
            autostart: entry.autostart,
            method: entry.method,
            cidr: entry.cidr,
            gateway: entry.gateway,
            bridgePorts: entry.bridgePorts,
            bondMode: entry.bondMode,
            slaves: entry.slaves,
            comment: entry.comment,
          })),
        });
      }
    }
  }

  // A node that left the cluster. Only ever pruned when the run saw the cluster
  // membership at all, which `discovered.nodes.length > 0` stands in for.
  if (discovered.nodes.length > 0) {
    await prisma.node.deleteMany({
      where: { clusterId: cluster.id, name: { notIn: discovered.nodes.map((n) => n.name) } },
    });
  }

  // --- guests ---------------------------------------------------------------
  for (const workload of discovered.workloads) {
    await upsertWorkload(prisma, cluster, workload, nodeIdByName, now);
  }

  if (discovered.workloads.length > 0) {
    await prisma.workload.deleteMany({
      where: { clusterId: cluster.id, vmid: { notIn: discovered.workloads.map((w) => w.vmid) } },
    });
  }

  // --- Ceph -----------------------------------------------------------------
  if (discovered.ceph) {
    for (const daemon of discovered.ceph.daemons) {
      const data = {
        tenantId: cluster.tenantId,
        kind: daemon.kind,
        host: daemon.host,
        version: daemon.version,
        nodeId: daemon.host ? (nodeIdByName.get(daemon.host) ?? null) : null,
        lastSeenAt: now,
      };

      await prisma.cephDaemon.upsert({
        where: { clusterId_daemonId: { clusterId: cluster.id, daemonId: daemon.name } },
        create: { clusterId: cluster.id, daemonId: daemon.name, ...data },
        update: data,
      });
    }

    await prisma.cephDaemon.deleteMany({
      where: {
        clusterId: cluster.id,
        daemonId: { notIn: discovered.ceph.daemons.map((daemon) => daemon.name) },
      },
    });
  } else {
    // Ceph was removed, or was never there. Either way the daemons are not.
    await prisma.cephDaemon.deleteMany({ where: { clusterId: cluster.id } });
  }

  return {
    nodesSeen: discovered.nodes.length,
    workloadsSeen: discovered.workloads.length,
    cephDaemonsSeen: discovered.ceph?.daemons.length ?? 0,
  };
}

async function upsertWorkload(
  prisma: VelnoxPrismaClient,
  cluster: { id: string; tenantId: string },
  workload: DiscoveredWorkload,
  nodeIdByName: Map<string, string>,
  now: Date,
): Promise<void> {
  const data = {
    tenantId: cluster.tenantId,
    nodeId: workload.node ? (nodeIdByName.get(workload.node) ?? null) : null,
    kind: workload.kind === 'qemu' ? ('QEMU' as const) : ('LXC' as const),
    name: workload.name,
    state: workloadState(workload.status),
    rawStatus: workload.status,
    template: workload.template,
    tags: workload.tags,
    pool: workload.pool,
    cpuCount: workload.cpuCount,
    cpuUsage: workload.cpuUsage,
    memoryBytes: big(workload.memoryBytes),
    memoryMaxBytes: big(workload.memoryMaxBytes),
    diskBytes: big(workload.diskBytes),
    diskMaxBytes: big(workload.diskMaxBytes),
    uptimeSeconds: seconds(workload.uptimeSeconds),
    lastSeenAt: now,
  };

  await prisma.workload.upsert({
    where: { clusterId_vmid: { clusterId: cluster.id, vmid: workload.vmid } },
    create: { clusterId: cluster.id, vmid: workload.vmid, ...data },
    update: data,
  });
}

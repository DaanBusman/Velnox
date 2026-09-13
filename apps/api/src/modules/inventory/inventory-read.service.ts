import { Injectable } from '@nestjs/common';
import type { HealthState, NodeState, WorkloadKind, WorkloadState } from '@velnox/db';
import { ERROR_CODES, VelnoxError } from '@velnox/shared';
import { PrismaService } from '../infrastructure/prisma.service';

/**
 * Reading the inventory.
 *
 * Every query here goes through the tenancy extension, so none of it filters by
 * tenant explicitly — the same code answers a tenant operator looking at their
 * three nodes and an MSP engineer looking at four hundred.
 *
 * `bigint` columns are turned into strings on the way out. JSON has no integer
 * type beyond 2^53, a 16 TiB pool is well inside that today, and a byte count
 * that silently loses precision in five years is the kind of bug nobody finds.
 */

const bytes = (value: bigint | null): string | null => (value === null ? null : value.toString());

export interface NodeSummary {
  id: string;
  clusterId: string;
  clusterName: string;
  tenantId: string;
  name: string;
  nodeId: number | null;
  address: string | null;
  state: NodeState;
  health: HealthState;
  pveVersion: string | null;
  kernelVersion: string | null;
  subscriptionStatus: string | null;
  subscriptionLevel: string | null;
  cpuCount: number | null;
  cpuModel: string | null;
  cpuUsage: number | null;
  memoryTotalBytes: string | null;
  memoryUsedBytes: string | null;
  rootfsTotalBytes: string | null;
  rootfsUsedBytes: string | null;
  uptimeSeconds: number | null;
  updatesAvailable: number | null;
  problems: string[];
  lastSeenAt: string | null;
}

export interface NodeDetail extends NodeSummary {
  repositories: {
    file: string;
    enabled: boolean;
    uris: string[];
    suites: string[];
    components: string[];
    comment: string | null;
  }[];
  storages: {
    name: string;
    type: string;
    enabled: boolean;
    active: boolean;
    shared: boolean;
    content: string[];
    totalBytes: string | null;
    usedBytes: string | null;
    availableBytes: string | null;
  }[];
  interfaces: {
    name: string;
    type: string;
    active: boolean;
    autostart: boolean;
    method: string | null;
    cidr: string | null;
    gateway: string | null;
    bridgePorts: string[];
    bondMode: string | null;
    slaves: string[];
    comment: string | null;
  }[];
  workloads: WorkloadSummary[];
  cephDaemons: CephDaemonSummary[];
}

export interface WorkloadSummary {
  id: string;
  vmid: number;
  kind: WorkloadKind;
  name: string | null;
  state: WorkloadState;
  rawStatus: string | null;
  template: boolean;
  tags: string[];
  pool: string | null;
  clusterId: string;
  clusterName: string;
  nodeId: string | null;
  nodeName: string | null;
  cpuCount: number | null;
  cpuUsage: number | null;
  memoryBytes: string | null;
  memoryMaxBytes: string | null;
  diskBytes: string | null;
  diskMaxBytes: string | null;
  uptimeSeconds: number | null;
  lastSeenAt: string | null;
}

export interface StorageRow {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  active: boolean;
  shared: boolean;
  content: string[];
  totalBytes: string | null;
  usedBytes: string | null;
  availableBytes: string | null;
  nodeId: string;
  nodeName: string;
  clusterId: string;
  clusterName: string;
}

export interface InterfaceRow {
  id: string;
  name: string;
  type: string;
  active: boolean;
  autostart: boolean;
  method: string | null;
  cidr: string | null;
  gateway: string | null;
  bridgePorts: string[];
  bondMode: string | null;
  slaves: string[];
  comment: string | null;
  nodeId: string;
  nodeName: string;
  clusterId: string;
  clusterName: string;
}

export interface CephDaemonSummary {
  id: string;
  kind: string;
  daemonId: string;
  host: string | null;
  version: string | null;
  nodeId: string | null;
  lastSeenAt: string | null;
}

@Injectable()
export class InventoryReadService {
  constructor(private readonly prisma: PrismaService) {}

  async listNodes(filter: { clusterId?: string; tenantId?: string }): Promise<NodeSummary[]> {
    const nodes = await this.prisma.client.node.findMany({
      where: {
        ...(filter.clusterId ? { clusterId: filter.clusterId } : {}),
        ...(filter.tenantId ? { tenantId: filter.tenantId } : {}),
      },
      include: { cluster: { select: { name: true } } },
      orderBy: [{ name: 'asc' }],
    });

    return nodes.map((node) => summariseNode(node));
  }

  async getNode(id: string): Promise<NodeDetail> {
    const node = await this.prisma.client.node.findFirst({
      where: { id },
      include: {
        cluster: { select: { name: true } },
        storages: { orderBy: [{ name: 'asc' }] },
        interfaces: { orderBy: [{ name: 'asc' }] },
        workloads: {
          include: { cluster: { select: { name: true } } },
          orderBy: [{ vmid: 'asc' }],
        },
        cephDaemons: { orderBy: [{ daemonId: 'asc' }] },
      },
    });

    if (!node) throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });

    return {
      ...summariseNode(node),
      repositories: Array.isArray(node.repositories)
        ? (node.repositories as NodeDetail['repositories'])
        : [],
      storages: node.storages.map((storage) => ({
        name: storage.name,
        type: storage.type,
        enabled: storage.enabled,
        active: storage.active,
        shared: storage.shared,
        content: storage.content,
        totalBytes: bytes(storage.totalBytes),
        usedBytes: bytes(storage.usedBytes),
        availableBytes: bytes(storage.availableBytes),
      })),
      interfaces: node.interfaces.map((entry) => ({
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
      workloads: node.workloads.map((workload) =>
        summariseWorkload({ ...workload, node: { name: node.name } }),
      ),
      cephDaemons: node.cephDaemons.map(summariseCephDaemon),
    };
  }

  async listWorkloads(filter: {
    clusterId?: string;
    nodeId?: string;
    kind?: WorkloadKind;
  }): Promise<WorkloadSummary[]> {
    const workloads = await this.prisma.client.workload.findMany({
      where: {
        ...(filter.clusterId ? { clusterId: filter.clusterId } : {}),
        ...(filter.nodeId ? { nodeId: filter.nodeId } : {}),
        ...(filter.kind ? { kind: filter.kind } : {}),
      },
      include: {
        cluster: { select: { name: true } },
        node: { select: { name: true } },
      },
      orderBy: [{ vmid: 'asc' }],
    });

    return workloads.map(summariseWorkload);
  }

  /**
   * Every storage on every node the caller can reach.
   *
   * A fleet-wide question — "where is the disk" — so it is a flat list rather
   * than something you have to open a cluster to find. The node and cluster
   * names come along because a storage called `local` on its own tells you
   * nothing.
   */
  async listStorages(filter: { clusterId?: string; nodeId?: string }): Promise<StorageRow[]> {
    const storages = await this.prisma.client.nodeStorage.findMany({
      where: {
        ...(filter.nodeId ? { nodeId: filter.nodeId } : {}),
        ...(filter.clusterId ? { node: { clusterId: filter.clusterId } } : {}),
      },
      include: {
        node: { select: { name: true, clusterId: true, cluster: { select: { name: true } } } },
      },
      orderBy: [{ name: 'asc' }],
    });

    return storages.map((storage) => ({
      id: storage.id,
      name: storage.name,
      type: storage.type,
      enabled: storage.enabled,
      active: storage.active,
      shared: storage.shared,
      content: storage.content,
      totalBytes: bytes(storage.totalBytes),
      usedBytes: bytes(storage.usedBytes),
      availableBytes: bytes(storage.availableBytes),
      nodeId: storage.nodeId,
      nodeName: storage.node.name,
      clusterId: storage.node.clusterId,
      clusterName: storage.node.cluster.name,
    }));
  }

  async listInterfaces(filter: { clusterId?: string; nodeId?: string }): Promise<InterfaceRow[]> {
    const interfaces = await this.prisma.client.nodeInterface.findMany({
      where: {
        ...(filter.nodeId ? { nodeId: filter.nodeId } : {}),
        ...(filter.clusterId ? { node: { clusterId: filter.clusterId } } : {}),
      },
      include: {
        node: { select: { name: true, clusterId: true, cluster: { select: { name: true } } } },
      },
      orderBy: [{ name: 'asc' }],
    });

    return interfaces.map((entry) => ({
      id: entry.id,
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
      nodeId: entry.nodeId,
      nodeName: entry.node.name,
      clusterId: entry.node.clusterId,
      clusterName: entry.node.cluster.name,
    }));
  }

  async listCephDaemons(clusterId: string): Promise<CephDaemonSummary[]> {
    const daemons = await this.prisma.client.cephDaemon.findMany({
      where: { clusterId },
      orderBy: [{ kind: 'asc' }, { daemonId: 'asc' }],
    });

    return daemons.map(summariseCephDaemon);
  }
}

function summariseNode(node: {
  id: string;
  clusterId: string;
  tenantId: string;
  name: string;
  nodeId: number | null;
  address: string | null;
  state: NodeState;
  health: HealthState;
  pveVersion: string | null;
  kernelVersion: string | null;
  subscriptionStatus: string | null;
  subscriptionLevel: string | null;
  cpuCount: number | null;
  cpuModel: string | null;
  cpuUsage: number | null;
  memoryTotalBytes: bigint | null;
  memoryUsedBytes: bigint | null;
  rootfsTotalBytes: bigint | null;
  rootfsUsedBytes: bigint | null;
  uptimeSeconds: number | null;
  updatesAvailable: number | null;
  problems: unknown;
  lastSeenAt: Date | null;
  cluster: { name: string };
}): NodeSummary {
  return {
    id: node.id,
    clusterId: node.clusterId,
    clusterName: node.cluster.name,
    tenantId: node.tenantId,
    name: node.name,
    nodeId: node.nodeId,
    address: node.address,
    state: node.state,
    health: node.health,
    pveVersion: node.pveVersion,
    kernelVersion: node.kernelVersion,
    subscriptionStatus: node.subscriptionStatus,
    subscriptionLevel: node.subscriptionLevel,
    cpuCount: node.cpuCount,
    cpuModel: node.cpuModel,
    cpuUsage: node.cpuUsage,
    memoryTotalBytes: bytes(node.memoryTotalBytes),
    memoryUsedBytes: bytes(node.memoryUsedBytes),
    rootfsTotalBytes: bytes(node.rootfsTotalBytes),
    rootfsUsedBytes: bytes(node.rootfsUsedBytes),
    uptimeSeconds: node.uptimeSeconds,
    updatesAvailable: node.updatesAvailable,
    problems: Array.isArray(node.problems) ? (node.problems as string[]) : [],
    lastSeenAt: node.lastSeenAt?.toISOString() ?? null,
  };
}

function summariseWorkload(workload: {
  id: string;
  vmid: number;
  kind: WorkloadKind;
  name: string | null;
  state: WorkloadState;
  rawStatus: string | null;
  template: boolean;
  tags: string[];
  pool: string | null;
  clusterId: string;
  nodeId: string | null;
  cpuCount: number | null;
  cpuUsage: number | null;
  memoryBytes: bigint | null;
  memoryMaxBytes: bigint | null;
  diskBytes: bigint | null;
  diskMaxBytes: bigint | null;
  uptimeSeconds: number | null;
  lastSeenAt: Date | null;
  cluster: { name: string };
  node?: { name: string } | null;
}): WorkloadSummary {
  return {
    id: workload.id,
    vmid: workload.vmid,
    kind: workload.kind,
    name: workload.name,
    state: workload.state,
    rawStatus: workload.rawStatus,
    template: workload.template,
    tags: workload.tags,
    pool: workload.pool,
    clusterId: workload.clusterId,
    clusterName: workload.cluster.name,
    nodeId: workload.nodeId,
    nodeName: workload.node?.name ?? null,
    cpuCount: workload.cpuCount,
    cpuUsage: workload.cpuUsage,
    memoryBytes: bytes(workload.memoryBytes),
    memoryMaxBytes: bytes(workload.memoryMaxBytes),
    diskBytes: bytes(workload.diskBytes),
    diskMaxBytes: bytes(workload.diskMaxBytes),
    uptimeSeconds: workload.uptimeSeconds,
    lastSeenAt: workload.lastSeenAt?.toISOString() ?? null,
  };
}

const summariseCephDaemon = (daemon: {
  id: string;
  kind: string;
  daemonId: string;
  host: string | null;
  version: string | null;
  nodeId: string | null;
  lastSeenAt: Date | null;
}): CephDaemonSummary => ({
  id: daemon.id,
  kind: daemon.kind,
  daemonId: daemon.daemonId,
  host: daemon.host,
  version: daemon.version,
  nodeId: daemon.nodeId,
  lastSeenAt: daemon.lastSeenAt?.toISOString() ?? null,
});

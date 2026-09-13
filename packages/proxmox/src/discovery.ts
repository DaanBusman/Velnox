import type {
  CephFlag,
  CephMetadata,
  CephStatus,
  ClusterResource,
  ClusterStatusEntry,
  NodeInterface,
  NodeListEntry,
  NodeStatus,
  NodeStorage,
  PendingUpdate,
  ProxmoxClient,
  RepositoryInfo,
  SubscriptionInfo,
  VersionInfo,
} from './client';

/**
 * Turning what Proxmox says into what Velnox stores.
 *
 * Split out from the client on purpose. The client knows HTTP; this knows what
 * the answers *mean*, and it is a pile of pure functions over plain objects —
 * which is what makes it testable against recorded responses from real clusters
 * rather than against a mock of what the documentation implies.
 *
 * Two rules run through all of it:
 *
 * **Missing is not zero.** A field Proxmox did not send becomes `null`, never
 * `0`. A node reporting no memory figure and a node reporting no memory are
 * different facts, and an inventory that renders both as "0 GB" is lying about
 * one of them.
 *
 * **Unknown is not healthy.** Anything unrecognised is carried through verbatim
 * and marked unknown, rather than being mapped to the nearest state that fits.
 */

// ---------------------------------------------------------------------------
// Output shapes
// ---------------------------------------------------------------------------

export type NodeState = 'online' | 'offline' | 'unknown';

export interface DiscoveredStorage {
  name: string;
  type: string;
  enabled: boolean;
  active: boolean;
  shared: boolean;
  content: string[];
  totalBytes: number | null;
  usedBytes: number | null;
  availableBytes: number | null;
}

export interface DiscoveredInterface {
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
}

export interface DiscoveredRepository {
  file: string;
  enabled: boolean;
  uris: string[];
  suites: string[];
  components: string[];
  comment: string | null;
}

export interface DiscoveredNode {
  name: string;
  state: NodeState;
  /** The cluster's own node id. Null on a standalone node. */
  nodeId: number | null;
  ip: string | null;
  pveVersion: string | null;
  kernelVersion: string | null;
  cpuCount: number | null;
  cpuModel: string | null;
  cpuUsage: number | null;
  memoryTotalBytes: number | null;
  memoryUsedBytes: number | null;
  rootfsTotalBytes: number | null;
  rootfsUsedBytes: number | null;
  uptimeSeconds: number | null;
  subscriptionStatus: string | null;
  subscriptionLevel: string | null;
  /** How many packages apt would install. Classification arrives in phase 6. */
  pendingUpdateCount: number | null;
  repositories: DiscoveredRepository[];
  storages: DiscoveredStorage[];
  interfaces: DiscoveredInterface[];
  /** Anything that failed for this node alone, so one bad node is not a failed run. */
  problems: string[];
}

export interface DiscoveredWorkload {
  vmid: number;
  kind: 'qemu' | 'lxc';
  name: string | null;
  node: string | null;
  status: string | null;
  template: boolean;
  cpuCount: number | null;
  cpuUsage: number | null;
  memoryBytes: number | null;
  memoryMaxBytes: number | null;
  diskBytes: number | null;
  diskMaxBytes: number | null;
  uptimeSeconds: number | null;
  tags: string[];
  pool: string | null;
}

export type CephDaemonKind = 'MON' | 'MGR' | 'OSD' | 'MDS' | 'RGW';

export interface DiscoveredCephDaemon {
  kind: CephDaemonKind;
  name: string;
  host: string | null;
  version: string | null;
}

export interface DiscoveredCeph {
  healthStatus: string;
  /** The named health checks, so an unrecognised warning is visible rather than flattened. */
  healthChecks: { code: string; severity: string; message: string }[];
  monInQuorum: number;
  monTotal: number;
  osdTotal: number | null;
  osdUp: number | null;
  osdIn: number | null;
  pgTotal: number | null;
  pgStates: { state: string; count: number }[];
  /** True only when every PG is `active+clean`. Anything else is not clean. */
  pgsClean: boolean;
  /** Flags that are set, such as `noout`. */
  flags: string[];
  daemons: DiscoveredCephDaemon[];
  /** Every daemon reports the same version. False is a cluster mid-upgrade. */
  versionsHomogeneous: boolean;
  versions: string[];
}

export interface DiscoveredCluster {
  /** The cluster's name, or null when this is a standalone node. */
  name: string | null;
  standalone: boolean;
  quorate: boolean | null;
  nodeCount: number;
  /** pve-manager version reported by the node Velnox connected to. */
  version: string | null;
  nodes: DiscoveredNode[];
  workloads: DiscoveredWorkload[];
  ceph: DiscoveredCeph | null;
  /** Every PVE version seen. More than one is a cluster mid-upgrade. */
  pveVersions: string[];
  problems: string[];
  discoveredAt: string;
}

// ---------------------------------------------------------------------------
// Small conversions
// ---------------------------------------------------------------------------

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const text = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

/** Proxmox sends booleans as 0/1, and sometimes not at all. */
const flag = (value: unknown, fallback = false): boolean =>
  value === 1 || value === true ? true : value === 0 || value === false ? false : fallback;

/**
 * Proxmox uses three separators for three list fields, so this accepts all of
 * them: `content` is comma-separated, `bridge_ports` and `slaves` are
 * space-separated, and **tags are semicolon-separated**. The semicolon was
 * missing here first, which turned `production;database` into one tag called
 * "production;database" — a filter by tag would then have matched nothing.
 */
const list = (value: unknown): string[] =>
  typeof value === 'string'
    ? value
        .split(/[,;\s]+/)
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];

// ---------------------------------------------------------------------------
// Per-resource mapping
// ---------------------------------------------------------------------------

export function mapStorage(row: NodeStorage): DiscoveredStorage {
  return {
    name: row.storage,
    type: row.type,
    enabled: flag(row.enabled, true),
    active: flag(row.active),
    shared: flag(row.shared),
    content: list(row.content),
    totalBytes: num(row.total),
    usedBytes: num(row.used),
    availableBytes: num(row.avail),
  };
}

export function mapInterface(row: NodeInterface): DiscoveredInterface {
  return {
    name: row.iface,
    type: row.type,
    active: flag(row.active),
    autostart: flag(row.autostart),
    method: text(row.method),
    // `cidr` is what modern PVE sends; `address` is the fallback on older ones,
    // and a bare address without a mask is still worth showing.
    cidr: text(row.cidr) ?? text(row.address),
    gateway: text(row.gateway),
    bridgePorts: list(row.bridge_ports),
    bondMode: text(row.bond_mode),
    slaves: list(row.slaves),
    comment: text(row.comments),
  };
}

export function mapRepositories(info: RepositoryInfo | null): DiscoveredRepository[] {
  const out: DiscoveredRepository[] = [];

  for (const file of info?.files ?? []) {
    for (const repository of file.repositories ?? []) {
      out.push({
        file: file.path,
        enabled: flag(repository.Enabled, true),
        uris: repository.URIs ?? [],
        suites: repository.Suites ?? [],
        components: repository.Components ?? [],
        comment: text(repository.Comment),
      });
    }
  }

  return out;
}

export function mapWorkload(resource: ClusterResource): DiscoveredWorkload | null {
  if (resource.type !== 'qemu' && resource.type !== 'lxc') return null;
  if (typeof resource.vmid !== 'number') return null;

  return {
    vmid: resource.vmid,
    kind: resource.type,
    name: text(resource.name),
    node: text(resource.node),
    status: text(resource.status),
    template: flag(resource.template),
    cpuCount: num(resource.maxcpu),
    cpuUsage: num(resource.cpu),
    memoryBytes: num(resource.mem),
    memoryMaxBytes: num(resource.maxmem),
    diskBytes: num(resource.disk),
    diskMaxBytes: num(resource.maxdisk),
    uptimeSeconds: num(resource.uptime),
    tags: list(resource.tags),
    pool: text(resource.pool),
  };
}

const nodeState = (value: string | undefined): NodeState =>
  value === 'online' ? 'online' : value === 'offline' ? 'offline' : 'unknown';

// ---------------------------------------------------------------------------
// Ceph
// ---------------------------------------------------------------------------

/**
 * Ceph, out of three separate endpoints.
 *
 * `status` is health and counts, `metadata` is which daemons exist and what
 * version each runs, `flags` is the set that includes `noout`. All three are
 * needed before phase 9A can decide whether an upgrade may start, so all three
 * are collected here rather than at upgrade time — inventory that has been
 * proven against real clusters for a phase is worth more than inventory written
 * the week it is depended on.
 */
export function mapCeph(input: {
  status: CephStatus | null;
  metadata: CephMetadata | null;
  flags: CephFlag[] | null;
}): DiscoveredCeph | null {
  if (!input.status) return null;

  const daemons: DiscoveredCephDaemon[] = [];
  const collect = (
    kind: CephDaemonKind,
    entries:
      | Record<
          string,
          {
            name?: string;
            hostname?: string;
            ceph_version_short?: string;
            ceph_version?: string;
            id?: number;
          }
        >
      | undefined,
  ): void => {
    for (const [key, entry] of Object.entries(entries ?? {})) {
      daemons.push({
        kind,
        name: entry?.name ?? (kind === 'OSD' ? `osd.${key}` : key),
        host: text(entry?.hostname),
        version: text(entry?.ceph_version_short) ?? text(entry?.ceph_version),
      });
    }
  };

  collect('MON', input.metadata?.mon);
  collect('MGR', input.metadata?.mgr);
  collect('OSD', input.metadata?.osd);
  collect('MDS', input.metadata?.mds);

  const versions = [
    ...new Set(daemons.map((daemon) => daemon.version).filter((v): v is string => v !== null)),
  ].sort();

  const osdmap = input.status.osdmap?.osdmap ?? input.status.osdmap;
  const pgStates = (input.status.pgmap?.pgs_by_state ?? [])
    .map((entry) => ({ state: entry.state_name ?? 'unknown', count: entry.count ?? 0 }))
    .sort((a, b) => b.count - a.count);

  const healthChecks = Object.entries(input.status.health?.checks ?? {}).map(([code, check]) => ({
    code,
    severity: check?.severity ?? 'unknown',
    message: check?.summary?.message ?? '',
  }));

  return {
    healthStatus: input.status.health?.status ?? 'UNKNOWN',
    healthChecks,
    monInQuorum: input.status.quorum_names?.length ?? input.status.quorum?.length ?? 0,
    monTotal: input.status.monmap?.mons?.length ?? 0,
    osdTotal: num(osdmap?.num_osds),
    osdUp: num(osdmap?.num_up_osds),
    osdIn: num(osdmap?.num_in_osds),
    pgTotal: num(input.status.pgmap?.num_pgs),
    pgStates,
    /*
     * Clean means every placement group is exactly `active+clean`.
     *
     * Not "no state mentions degraded" — a cluster backfilling is also not
     * clean, and phase 9A refuses to start an upgrade on either. Written as a
     * positive test for that reason: a negative one has to enumerate every bad
     * state Ceph can invent, and it will invent more.
     */
    pgsClean: pgStates.length > 0 && pgStates.every((entry) => entry.state === 'active+clean'),
    flags: (input.flags ?? [])
      .filter((entry) => flag(entry.value))
      .map((entry) => entry.name)
      .sort(),
    daemons: daemons.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)),
    versionsHomogeneous: versions.length <= 1,
    versions,
  };
}

// ---------------------------------------------------------------------------
// The whole run
// ---------------------------------------------------------------------------

export interface NodeFacts {
  entry: NodeListEntry;
  status: NodeStatus | null;
  subscription: SubscriptionInfo | null;
  repositories: RepositoryInfo | null;
  updates: PendingUpdate[] | null;
  storages: NodeStorage[] | null;
  interfaces: NodeInterface[] | null;
  clusterEntry: ClusterStatusEntry | null;
  problems: string[];
}

export function mapNode(facts: NodeFacts): DiscoveredNode {
  const { entry, status } = facts;

  return {
    name: entry.node,
    state: nodeState(entry.status),
    nodeId: num(facts.clusterEntry?.nodeid),
    ip: text(facts.clusterEntry?.ip),
    pveVersion: text(status?.pveversion),
    kernelVersion: text(status?.['current-kernel']?.release) ?? text(status?.kversion),
    cpuCount: num(status?.cpuinfo?.cpus) ?? num(entry.maxcpu),
    cpuModel: text(status?.cpuinfo?.model),
    cpuUsage: num(entry.cpu),
    memoryTotalBytes: num(status?.memory?.total) ?? num(entry.maxmem),
    memoryUsedBytes: num(status?.memory?.used) ?? num(entry.mem),
    rootfsTotalBytes: num(status?.rootfs?.total) ?? num(entry.maxdisk),
    rootfsUsedBytes: num(status?.rootfs?.used) ?? num(entry.disk),
    uptimeSeconds: num(status?.uptime) ?? num(entry.uptime),
    subscriptionStatus: text(facts.subscription?.status),
    subscriptionLevel: text(facts.subscription?.level) ?? text(entry.level),
    pendingUpdateCount: facts.updates ? facts.updates.length : null,
    repositories: mapRepositories(facts.repositories),
    storages: (facts.storages ?? []).map(mapStorage),
    interfaces: (facts.interfaces ?? []).map(mapInterface),
    problems: facts.problems,
  };
}

export function assembleCluster(input: {
  version: VersionInfo | null;
  clusterStatus: ClusterStatusEntry[];
  nodes: NodeFacts[];
  resources: ClusterResource[];
  ceph: DiscoveredCeph | null;
  problems: string[];
}): DiscoveredCluster {
  const clusterRow = input.clusterStatus.find((entry) => entry.type === 'cluster');
  const mappedNodes = input.nodes.map(mapNode);

  const pveVersions = [
    ...new Set(mappedNodes.map((node) => node.pveVersion).filter((v): v is string => v !== null)),
  ].sort();

  return {
    name: text(clusterRow?.name),
    /*
     * A standalone node answers /cluster/status with one row of type `node` and
     * no cluster row at all. That is the distinction, and it is not cosmetic:
     * quorum does not apply to a standalone node, and reporting it as "not
     * quorate" would make a healthy machine look broken.
     */
    standalone: clusterRow === undefined,
    quorate: clusterRow ? flag(clusterRow.quorate) : null,
    nodeCount: mappedNodes.length,
    version: text(input.version?.version),
    nodes: mappedNodes.sort((a, b) => a.name.localeCompare(b.name)),
    workloads: input.resources
      .map(mapWorkload)
      .filter((workload): workload is DiscoveredWorkload => workload !== null)
      .sort((a, b) => a.vmid - b.vmid),
    ceph: input.ceph,
    pveVersions,
    problems: input.problems,
    discoveredAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Driving the client
// ---------------------------------------------------------------------------

/** Run one call, and turn a failure into a recorded problem instead of a dead run. */
async function attempt<T>(
  label: string,
  problems: string[],
  operation: () => Promise<T>,
): Promise<T | null> {
  try {
    return await operation();
  } catch (error) {
    problems.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Discover everything, from one connection.
 *
 * The failure model is the important part. A cluster with one unreachable node
 * must produce an inventory of the other fourteen *and* a recorded problem for
 * the fifteenth — not an exception, and not a silent success. So every
 * per-node call is wrapped, and what it could not learn is carried on the node
 * itself.
 *
 * Ceph is attempted on every cluster and its absence is not a problem: a
 * non-Ceph cluster answers `/cluster/ceph/status` with an error, and that is the
 * correct answer for a cluster that has no Ceph. It shows no Ceph surface at
 * all rather than empty tiles.
 */
export async function discoverCluster(client: ProxmoxClient): Promise<DiscoveredCluster> {
  const problems: string[] = [];

  const version = await attempt('version', problems, () => client.version());
  const clusterStatus =
    (await attempt('cluster status', problems, () => client.clusterStatus())) ?? [];
  const nodeList = (await attempt('node list', problems, () => client.nodes())) ?? [];
  const resources =
    (await attempt('cluster resources', problems, () => client.clusterResources())) ?? [];

  const nodeFacts: NodeFacts[] = [];

  for (const entry of nodeList) {
    const nodeProblems: string[] = [];

    /*
     * An offline node is asked nothing.
     *
     * Every call would time out, one after another, and on a cluster with two
     * nodes down that is minutes of waiting to learn what /nodes already said.
     * What it knows from the cluster's own view is still recorded.
     */
    if (entry.status !== 'online') {
      nodeFacts.push({
        entry,
        status: null,
        subscription: null,
        repositories: null,
        updates: null,
        storages: null,
        interfaces: null,
        clusterEntry:
          clusterStatus.find((row) => row.type === 'node' && row.name === entry.node) ?? null,
        problems: [`node is ${entry.status}; per-node detail was not collected`],
      });
      continue;
    }

    const [status, subscription, repositories, updates, storages, interfaces] = await Promise.all([
      attempt(`${entry.node} status`, nodeProblems, () => client.nodeStatus(entry.node)),
      attempt(`${entry.node} subscription`, nodeProblems, () =>
        client.nodeSubscription(entry.node),
      ),
      attempt(`${entry.node} repositories`, nodeProblems, () =>
        client.nodeRepositories(entry.node),
      ),
      attempt(`${entry.node} updates`, nodeProblems, () => client.nodeUpdates(entry.node)),
      attempt(`${entry.node} storage`, nodeProblems, () => client.nodeStorage(entry.node)),
      attempt(`${entry.node} network`, nodeProblems, () => client.nodeNetwork(entry.node)),
    ]);

    nodeFacts.push({
      entry,
      status,
      subscription,
      repositories,
      updates,
      storages,
      interfaces,
      clusterEntry:
        clusterStatus.find((row) => row.type === 'node' && row.name === entry.node) ?? null,
      problems: nodeProblems,
    });
  }

  // Deliberately not wrapped in `attempt`: a cluster without Ceph is not a
  // cluster with a problem.
  const ceph = await discoverCeph(client);

  return assembleCluster({ version, clusterStatus, nodes: nodeFacts, resources, ceph, problems });
}

/** Null when this cluster has no Ceph, which is an answer rather than a failure. */
export async function discoverCeph(client: ProxmoxClient): Promise<DiscoveredCeph | null> {
  let status: CephStatus | null = null;
  try {
    status = await client.cephStatus();
  } catch {
    return null;
  }

  // Metadata and flags are best-effort: a cluster whose Ceph is unhealthy may
  // answer status and fail the others, and half a picture beats none.
  const metadata = await client.cephMetadata().catch(() => null);
  const flags = await client.cephFlags().catch(() => null);

  return mapCeph({ status, metadata, flags });
}

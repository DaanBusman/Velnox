import { describe, expect, it } from 'vitest';
import type { DiscoveredCeph, DiscoveredCluster, DiscoveredNode } from '@velnox/proxmox';
import { clusterHealth, nodeHealth, workloadState } from './persist';

/**
 * The two judgements discovery makes.
 *
 * Mapping Proxmox's words onto Velnox's is where an inventory quietly starts
 * lying, so both directions are pinned: nothing unrecognised may read as
 * healthy, and nothing healthy may read as broken.
 */

const node = (over: Partial<DiscoveredNode> = {}): DiscoveredNode => ({
  name: 'pve1',
  state: 'online',
  nodeId: 1,
  ip: '10.0.0.11',
  pveVersion: '8.2.4',
  kernelVersion: '6.8.12-1-pve',
  cpuCount: 32,
  cpuModel: 'AMD EPYC 7313P',
  cpuUsage: 0.1,
  memoryTotalBytes: 137_438_953_472,
  memoryUsedBytes: 68_719_476_736,
  rootfsTotalBytes: 107_374_182_400,
  rootfsUsedBytes: 21_474_836_480,
  uptimeSeconds: 864_000,
  subscriptionStatus: 'active',
  subscriptionLevel: 'c',
  pendingUpdateCount: 0,
  repositories: [],
  storages: [],
  interfaces: [],
  problems: [],
  ...over,
});

const ceph = (over: Partial<DiscoveredCeph> = {}): DiscoveredCeph => ({
  healthStatus: 'HEALTH_OK',
  healthChecks: [],
  monInQuorum: 3,
  monTotal: 3,
  osdTotal: 12,
  osdUp: 12,
  osdIn: 12,
  pgTotal: 513,
  pgStates: [{ state: 'active+clean', count: 513 }],
  pgsClean: true,
  flags: [],
  daemons: [],
  versionsHomogeneous: true,
  versions: ['18.2.4'],
  ...over,
});

const cluster = (over: Partial<DiscoveredCluster> = {}): DiscoveredCluster => ({
  name: 'production',
  standalone: false,
  quorate: true,
  nodeCount: 3,
  version: '8.2.4',
  nodes: [node(), node({ name: 'pve2' }), node({ name: 'pve3' })],
  workloads: [],
  ceph: null,
  pveVersions: ['8.2.4'],
  problems: [],
  discoveredAt: new Date().toISOString(),
  ...over,
});

describe('a cluster’s health', () => {
  it('is OK for a quorate cluster with every node online', () => {
    expect(clusterHealth(cluster())).toBe('OK');
  });

  it('is UNKNOWN when the run learned about no nodes at all', () => {
    // Not OK. A cluster Velnox knows nothing about must not read as healthy —
    // that is the single most expensive way for this function to be wrong.
    expect(clusterHealth(cluster({ nodes: [] }))).toBe('UNKNOWN');
  });

  it('is CRITICAL when a cluster has lost quorum', () => {
    expect(clusterHealth(cluster({ quorate: false }))).toBe('CRITICAL');
  });

  it('is not CRITICAL for a standalone node, which has no quorum to lose', () => {
    // A standalone node is modelled as a cluster of one and reports no quorum.
    // Reading that as "lost quorum" would make a perfectly healthy machine red.
    expect(clusterHealth(cluster({ standalone: true, quorate: null, nodes: [node()] }))).toBe('OK');
  });

  it('is CRITICAL when Ceph is in error', () => {
    expect(clusterHealth(cluster({ ceph: ceph({ healthStatus: 'HEALTH_ERR' }) }))).toBe('CRITICAL');
  });

  it('is WARNING when a node is offline', () => {
    expect(
      clusterHealth(cluster({ nodes: [node(), node({ name: 'pve2', state: 'offline' })] })),
    ).toBe('WARNING');
  });

  it('is WARNING when Ceph is anything other than HEALTH_OK', () => {
    // Including a status this build has never heard of. Unrecognised is not
    // healthy.
    expect(clusterHealth(cluster({ ceph: ceph({ healthStatus: 'HEALTH_SOMETHING_NEW' }) }))).toBe(
      'WARNING',
    );
  });

  it('is WARNING when a flag such as noout is set', () => {
    // A cluster left with noout after an aborted maintenance window is the
    // silent time bomb phase 9A has to refuse to upgrade.
    expect(clusterHealth(cluster({ ceph: ceph({ flags: ['noout'] }) }))).toBe('WARNING');
  });

  it('is WARNING when the nodes disagree about their PVE version', () => {
    expect(clusterHealth(cluster({ pveVersions: ['8.2.4', '9.0.3'] }))).toBe('WARNING');
  });

  it('is WARNING when the run could not learn something', () => {
    expect(clusterHealth(cluster({ problems: ['cluster resources: timed out'] }))).toBe('WARNING');
  });
});

describe('a node’s health', () => {
  it('is OK for an online node with nothing to report', () => {
    expect(nodeHealth(node())).toBe('OK');
  });

  it('is CRITICAL for an offline node', () => {
    expect(nodeHealth(node({ state: 'offline' }))).toBe('CRITICAL');
  });

  it('is UNKNOWN for a node in a state Proxmox did not name', () => {
    expect(nodeHealth(node({ state: 'unknown' }))).toBe('UNKNOWN');
  });

  it('is WARNING for an online node the run could not fully read', () => {
    expect(nodeHealth(node({ problems: ['pve1 repositories: HTTP 403'] }))).toBe('WARNING');
  });
});

describe('a guest’s state', () => {
  it('maps the states Proxmox actually uses', () => {
    expect(workloadState('running')).toBe('RUNNING');
    expect(workloadState('stopped')).toBe('STOPPED');
    expect(workloadState('paused')).toBe('PAUSED');
    expect(workloadState('suspended')).toBe('PAUSED');
  });

  it('leaves anything else UNKNOWN rather than guessing', () => {
    // `rawStatus` keeps the original beside it, so a state a later Proxmox
    // invents is visible rather than flattened into one of ours.
    expect(workloadState('prelaunch')).toBe('UNKNOWN');
    expect(workloadState(null)).toBe('UNKNOWN');
  });
});

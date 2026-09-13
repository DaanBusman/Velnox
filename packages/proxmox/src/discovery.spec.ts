import { describe, expect, it } from 'vitest';
import {
  assembleCluster,
  mapCeph,
  mapInterface,
  mapRepositories,
  mapStorage,
  mapWorkload,
} from './discovery';
import type { CephFlag, CephMetadata, CephStatus, ClusterResource } from './client';

/**
 * Turning Proxmox's answers into inventory.
 *
 * The fixtures below are the shapes a PVE 8 cluster actually returns, trimmed to
 * the fields Velnox reads. Two rules are asserted throughout, because both have
 * failed in obvious-looking ways elsewhere:
 *
 *   missing is null, never zero — "no figure" and "zero" are different facts;
 *   unknown is unknown, never mapped to the nearest healthy-looking state.
 */

describe('storage', () => {
  it('reads a healthy shared storage', () => {
    const mapped = mapStorage({
      storage: 'ceph-vm',
      type: 'rbd',
      active: 1,
      enabled: 1,
      shared: 1,
      content: 'images,rootdir',
      total: 10_995_116_277_760,
      used: 3_298_534_883_328,
      avail: 7_696_581_394_432,
    });

    expect(mapped.shared).toBe(true);
    expect(mapped.content).toEqual(['images', 'rootdir']);
    expect(mapped.totalBytes).toBe(10_995_116_277_760);
  });

  it('reports an absent size as null, not as an empty disk', () => {
    // An inactive storage sends no figures at all. Rendering that as 0 B would
    // say the array is empty, which is the opposite of "we could not ask".
    const mapped = mapStorage({ storage: 'backup-nfs', type: 'nfs', active: 0, enabled: 1 });

    expect(mapped.active).toBe(false);
    expect(mapped.totalBytes).toBeNull();
    expect(mapped.usedBytes).toBeNull();
  });

  it('treats a storage with no `enabled` field as enabled', () => {
    // Older point releases omit it, and the meaning there is "enabled".
    expect(mapStorage({ storage: 'local', type: 'dir' }).enabled).toBe(true);
  });
});

describe('network interfaces', () => {
  it('reads a bridge', () => {
    const mapped = mapInterface({
      iface: 'vmbr0',
      type: 'bridge',
      active: 1,
      autostart: 1,
      method: 'static',
      cidr: '10.0.0.11/24',
      gateway: '10.0.0.1',
      bridge_ports: 'bond0',
      bridge_vlan_aware: 1,
    });

    expect(mapped.cidr).toBe('10.0.0.11/24');
    expect(mapped.bridgePorts).toEqual(['bond0']);
  });

  it('falls back to `address` when a node is too old to send `cidr`', () => {
    const mapped = mapInterface({ iface: 'eth0', type: 'eth', address: '10.0.0.11' });
    expect(mapped.cidr).toBe('10.0.0.11');
  });

  it('splits bond slaves', () => {
    const mapped = mapInterface({
      iface: 'bond0',
      type: 'bond',
      bond_mode: '802.3ad',
      slaves: 'enp1s0f0 enp1s0f1',
    });
    expect(mapped.slaves).toEqual(['enp1s0f0', 'enp1s0f1']);
  });
});

describe('repositories', () => {
  it('flattens the files into one list, keeping which file each came from', () => {
    const mapped = mapRepositories({
      files: [
        {
          path: '/etc/apt/sources.list',
          repositories: [
            {
              Enabled: 1,
              Types: ['deb'],
              URIs: ['http://deb.debian.org/debian'],
              Suites: ['bookworm'],
              Components: ['main', 'contrib'],
            },
          ],
        },
        {
          path: '/etc/apt/sources.list.d/pve-enterprise.list',
          repositories: [
            {
              Enabled: 0,
              Types: ['deb'],
              URIs: ['https://enterprise.proxmox.com/debian/pve'],
              Suites: ['bookworm'],
              Components: ['pve-enterprise'],
              Comment: 'no subscription',
            },
          ],
        },
      ],
    });

    expect(mapped).toHaveLength(2);
    expect(mapped[1]?.enabled).toBe(false);
    expect(mapped[1]?.file).toBe('/etc/apt/sources.list.d/pve-enterprise.list');
    expect(mapped[1]?.comment).toBe('no subscription');
  });

  it('survives a node that could not be asked', () => {
    expect(mapRepositories(null)).toEqual([]);
  });
});

describe('workloads', () => {
  const vm: ClusterResource = {
    id: 'qemu/100',
    type: 'qemu',
    node: 'pve1',
    vmid: 100,
    name: 'db-primary',
    status: 'running',
    cpu: 0.12,
    maxcpu: 8,
    mem: 8_589_934_592,
    maxmem: 17_179_869_184,
    disk: 0,
    maxdisk: 107_374_182_400,
    uptime: 864_000,
    tags: 'production;database',
  };

  it('reads a running virtual machine', () => {
    const mapped = mapWorkload(vm)!;
    expect(mapped.kind).toBe('qemu');
    expect(mapped.vmid).toBe(100);
    expect(mapped.cpuCount).toBe(8);
    expect(mapped.template).toBe(false);
    expect(mapped.tags).toEqual(['production', 'database']);
  });

  it('marks a template as one', () => {
    expect(mapWorkload({ ...vm, template: 1 })!.template).toBe(true);
  });

  it('ignores rows that are not guests', () => {
    // /cluster/resources returns nodes, storage and pools in the same array.
    expect(mapWorkload({ id: 'node/pve1', type: 'node', node: 'pve1' })).toBeNull();
    expect(mapWorkload({ id: 'storage/pve1/local', type: 'storage', storage: 'local' })).toBeNull();
  });
});

describe('Ceph', () => {
  const healthy: CephStatus = {
    health: { status: 'HEALTH_OK', checks: {} },
    monmap: { mons: [{ name: 'pve1' }, { name: 'pve2' }, { name: 'pve3' }] },
    quorum_names: ['pve1', 'pve2', 'pve3'],
    osdmap: { osdmap: { num_osds: 12, num_up_osds: 12, num_in_osds: 12 } },
    pgmap: { num_pgs: 513, pgs_by_state: [{ state_name: 'active+clean', count: 513 }] },
  };

  const metadata: CephMetadata = {
    mon: { pve1: { name: 'pve1', hostname: 'pve1', ceph_version_short: '18.2.4' } },
    mgr: { pve1: { name: 'pve1', hostname: 'pve1', ceph_version_short: '18.2.4' } },
    osd: { '0': { id: 0, hostname: 'pve1', ceph_version_short: '18.2.4' } },
  };

  it('reads a healthy cluster', () => {
    const ceph = mapCeph({ status: healthy, metadata, flags: [] })!;

    expect(ceph.healthStatus).toBe('HEALTH_OK');
    expect(ceph.monInQuorum).toBe(3);
    expect(ceph.monTotal).toBe(3);
    expect(ceph.osdUp).toBe(12);
    expect(ceph.pgsClean).toBe(true);
    expect(ceph.versionsHomogeneous).toBe(true);
    expect(ceph.daemons.map((d) => d.kind)).toEqual(['MGR', 'MON', 'OSD']);
  });

  it('names OSD daemons by their id, because the metadata key is all there is', () => {
    const ceph = mapCeph({ status: healthy, metadata, flags: [] })!;
    expect(ceph.daemons.find((d) => d.kind === 'OSD')?.name).toBe('osd.0');
  });

  it('is not clean while a placement group is backfilling', () => {
    // The failure this guards: "no state mentions degraded" reads as clean, and
    // phase 9A would start an upgrade on a cluster that is still moving data.
    const ceph = mapCeph({
      status: {
        ...healthy,
        pgmap: {
          num_pgs: 513,
          pgs_by_state: [
            { state_name: 'active+clean', count: 500 },
            { state_name: 'active+remapped+backfilling', count: 13 },
          ],
        },
      },
      metadata,
      flags: [],
    })!;

    expect(ceph.pgsClean).toBe(false);
  });

  it('is not clean when it reports no placement groups at all', () => {
    const ceph = mapCeph({ status: { ...healthy, pgmap: {} }, metadata, flags: [] })!;
    expect(ceph.pgsClean).toBe(false);
  });

  it('surfaces noout rather than swallowing it', () => {
    // A cluster left with noout set after a maintenance window is the exact
    // situation phase 9A has to refuse, and phase 4 is where it becomes visible.
    const flags: CephFlag[] = [
      { name: 'noout', value: 1 },
      { name: 'nobackfill', value: 0 },
    ];

    expect(mapCeph({ status: healthy, metadata, flags })!.flags).toEqual(['noout']);
  });

  it('reports a cluster mid-upgrade as not homogeneous', () => {
    const mixed: CephMetadata = {
      mon: { pve1: { name: 'pve1', ceph_version_short: '18.2.4' } },
      osd: { '0': { id: 0, ceph_version_short: '17.2.7' } },
    };

    const ceph = mapCeph({ status: healthy, metadata: mixed, flags: [] })!;
    expect(ceph.versionsHomogeneous).toBe(false);
    expect(ceph.versions).toEqual(['17.2.7', '18.2.4']);
  });

  it('keeps an unrecognised health check verbatim', () => {
    const ceph = mapCeph({
      status: {
        ...healthy,
        health: {
          status: 'HEALTH_WARN',
          checks: {
            SOMETHING_NEW: {
              severity: 'HEALTH_WARN',
              summary: { message: '2 daemons have recently crashed' },
            },
          },
        },
      },
      metadata,
      flags: [],
    })!;

    expect(ceph.healthStatus).toBe('HEALTH_WARN');
    expect(ceph.healthChecks).toEqual([
      {
        code: 'SOMETHING_NEW',
        severity: 'HEALTH_WARN',
        message: '2 daemons have recently crashed',
      },
    ]);
  });

  it('is null for a cluster that has no Ceph', () => {
    // Not an empty object with zeroes in it. A non-Ceph cluster must show no
    // Ceph surface at all rather than tiles reading "0 OSDs".
    expect(mapCeph({ status: null, metadata: null, flags: null })).toBeNull();
  });
});

describe('assembling a cluster', () => {
  const node = (name: string, version: string, status: 'online' | 'offline' = 'online') => ({
    entry: { node: name, status },
    status: { pveversion: version, uptime: 100 },
    subscription: null,
    repositories: null,
    updates: null,
    storages: null,
    interfaces: null,
    clusterEntry: { type: 'node' as const, id: `node/${name}`, name, nodeid: 1, ip: '10.0.0.1' },
    problems: [],
  });

  it('reads a three-node cluster', () => {
    const cluster = assembleCluster({
      version: { version: '8.2.4' },
      clusterStatus: [
        { type: 'cluster', id: 'cluster', name: 'production', nodes: 3, quorate: 1 },
        { type: 'node', id: 'node/pve1', name: 'pve1', online: 1 },
      ],
      nodes: [node('pve1', '8.2.4'), node('pve2', '8.2.4'), node('pve3', '8.2.4')],
      resources: [],
      ceph: null,
      problems: [],
    });

    expect(cluster.name).toBe('production');
    expect(cluster.standalone).toBe(false);
    expect(cluster.quorate).toBe(true);
    expect(cluster.nodeCount).toBe(3);
    expect(cluster.pveVersions).toEqual(['8.2.4']);
  });

  it('reads a standalone node as standalone, not as a cluster without quorum', () => {
    // A standalone node answers /cluster/status with one row of type `node` and
    // no cluster row. Reporting it as "not quorate" would make a perfectly
    // healthy machine look broken.
    const cluster = assembleCluster({
      version: { version: '8.2.4' },
      clusterStatus: [{ type: 'node', id: 'node/pve1', name: 'pve1', online: 1 }],
      nodes: [node('pve1', '8.2.4')],
      resources: [],
      ceph: null,
      problems: [],
    });

    expect(cluster.standalone).toBe(true);
    expect(cluster.name).toBeNull();
    expect(cluster.quorate).toBeNull();
  });

  it('reports mixed PVE versions, which is a cluster mid-upgrade', () => {
    const cluster = assembleCluster({
      version: { version: '9.0.3' },
      clusterStatus: [{ type: 'cluster', id: 'cluster', name: 'production', quorate: 1 }],
      nodes: [node('pve1', '9.0.3'), node('pve2', '8.2.4')],
      resources: [],
      ceph: null,
      problems: [],
    });

    expect(cluster.pveVersions).toEqual(['8.2.4', '9.0.3']);
  });

  it('keeps an offline node in the inventory, carrying why it knows nothing about it', () => {
    // Dropping it would make a node disappear at the moment it most needs
    // looking at.
    const offline = node('pve3', '8.2.4', 'offline');
    offline.status = null as never;
    offline.problems = ['node is offline; per-node detail was not collected'];

    const cluster = assembleCluster({
      version: { version: '8.2.4' },
      clusterStatus: [{ type: 'cluster', id: 'cluster', name: 'production', quorate: 1 }],
      nodes: [node('pve1', '8.2.4'), offline],
      resources: [],
      ceph: null,
      problems: [],
    });

    const third = cluster.nodes.find((n) => n.name === 'pve3')!;
    expect(third.state).toBe('offline');
    expect(third.pveVersion).toBeNull();
    expect(third.problems).toHaveLength(1);
  });

  it('sorts nodes by name and guests by vmid, so a diff between runs is readable', () => {
    const cluster = assembleCluster({
      version: null,
      clusterStatus: [],
      nodes: [node('pve3', '8.2.4'), node('pve1', '8.2.4')],
      resources: [
        { id: 'qemu/200', type: 'qemu', vmid: 200, node: 'pve1' },
        { id: 'lxc/101', type: 'lxc', vmid: 101, node: 'pve1' },
      ],
      ceph: null,
      problems: [],
    });

    expect(cluster.nodes.map((n) => n.name)).toEqual(['pve1', 'pve3']);
    expect(cluster.workloads.map((w) => w.vmid)).toEqual([101, 200]);
  });
});

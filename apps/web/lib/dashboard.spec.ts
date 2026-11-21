import { describe, expect, it } from 'vitest';
import type { ClusterSummary, NodeSummary, StorageRow } from '@/lib/session-types';
import { capacityByCluster, distinctStorages, fullStorages, niceMax, updateSplit } from './dashboard';

const cluster = (id: string, extra: Partial<ClusterSummary> = {}) =>
  ({ id, name: id, connectionState: 'CONNECTED', lastSeenAt: null, ...extra }) as ClusterSummary;

const node = (name: string, extra: Partial<NodeSummary> = {}) =>
  ({
    id: name,
    name,
    clusterId: 'a',
    state: 'ONLINE',
    cpuCount: 4,
    cpuUsage: 0.5,
    memoryUsedBytes: '50',
    memoryTotalBytes: '100',
    updatesAvailable: 0,
    ...extra,
  }) as NodeSummary;

const storage = (name: string, nodeId: string, extra: Partial<StorageRow> = {}) =>
  ({
    name,
    nodeId,
    clusterId: 'a',
    enabled: true,
    active: true,
    shared: false,
    usedBytes: '10',
    totalBytes: '100',
    ...extra,
  }) as StorageRow;

describe('distinctStorages', () => {
  it('counts a shared storage once and a local one per node', () => {
    const rows = [
      storage('ceph', 'n1', { shared: true }),
      storage('ceph', 'n2', { shared: true }),
      storage('local', 'n1'),
      storage('local', 'n2'),
    ];
    expect(distinctStorages(rows).map((s) => `${s.name}@${s.nodeId}`)).toEqual([
      'ceph@n1',
      'local@n1',
      'local@n2',
    ]);
  });

  it('keeps the same shared name in two clusters apart', () => {
    const rows = [
      storage('nfs', 'n1', { shared: true }),
      storage('nfs', 'n9', { shared: true, clusterId: 'b' }),
    ];
    expect(distinctStorages(rows)).toHaveLength(2);
  });

  it('leaves out what is disabled or inactive', () => {
    const rows = [storage('off', 'n1', { enabled: false }), storage('down', 'n1', { active: false })];
    expect(distinctStorages(rows)).toHaveLength(0);
  });
});

describe('capacityByCluster', () => {
  it('weighs CPU by cores', () => {
    const [row] = capacityByCluster(
      [cluster('a')],
      [node('big', { cpuCount: 30, cpuUsage: 1 }), node('small', { cpuCount: 10, cpuUsage: 0 })],
      [],
    );
    expect(row?.cpu).toBeCloseTo(0.75);
  });

  it('ignores an offline node’s last figures', () => {
    const [row] = capacityByCluster(
      [cluster('a')],
      [node('up'), node('down', { state: 'OFFLINE', cpuUsage: 1, memoryUsedBytes: '100' })],
      [],
    );
    expect(row?.cpu).toBe(0.5);
    expect(row?.memory).toBe(0.5);
  });

  it('has no figure rather than zero when nothing reported one', () => {
    const [row] = capacityByCluster(
      [cluster('a')],
      [node('n', { cpuUsage: null, memoryUsedBytes: null, memoryTotalBytes: null })],
      [],
    );
    expect(row).toMatchObject({ cpu: null, memory: null, storage: null });
  });

  it('adds byte counts beyond what a JSON number holds', () => {
    const huge = '9007199254740993000';
    const [row] = capacityByCluster(
      [cluster('a')],
      [],
      [storage('x', 'n1', { usedBytes: huge, totalBytes: huge })],
    );
    expect(row?.storage).toBe(1);
  });

  it('counts shared storage once in the total', () => {
    const [row] = capacityByCluster(
      [cluster('a')],
      [],
      [
        storage('ceph', 'n1', { shared: true, usedBytes: '90', totalBytes: '100' }),
        storage('ceph', 'n2', { shared: true, usedBytes: '90', totalBytes: '100' }),
        storage('local', 'n1', { usedBytes: '10', totalBytes: '100' }),
      ],
    );
    expect(row?.storage).toBe(0.5);
  });

  it('marks a cluster it could not read as stale, and puts the fullest first', () => {
    const rows = capacityByCluster(
      [cluster('calm'), cluster('a', { connectionState: 'FAILED' })],
      [node('n', { clusterId: 'calm', cpuUsage: 0.1, memoryUsedBytes: '1' }), node('m', { cpuUsage: 0.9 })],
      [],
    );
    expect(rows.map((r) => r.id)).toEqual(['a', 'calm']);
    expect(rows[0]?.stale).toBe(true);
    expect(rows[1]?.stale).toBe(false);
  });
});

describe('fullStorages', () => {
  it('names a storage at ninety percent, once, and not one below it', () => {
    const rows = [
      storage('full', 'n1', { shared: true, usedBytes: '90', totalBytes: '100' }),
      storage('full', 'n2', { shared: true, usedBytes: '90', totalBytes: '100' }),
      storage('fine', 'n1', { usedBytes: '89', totalBytes: '100' }),
      storage('unknown', 'n1', { usedBytes: null, totalBytes: null }),
    ];
    expect(fullStorages(rows).map((s) => s.name)).toEqual(['full']);
  });
});

describe('updateSplit', () => {
  it('never counts a node nobody checked as up to date', () => {
    const split = updateSplit([
      node('a', { updatesAvailable: 0 }),
      node('b', { updatesAvailable: null }),
      node('c', { updatesAvailable: 3 }),
      node('d', { updatesAvailable: 12 }),
    ]);
    expect(split).toMatchObject({ current: 1, unknown: 1, pending: 2 });
    expect(split.most.map((n) => n.name)).toEqual(['d', 'c']);
  });
});

describe('niceMax', () => {
  it('rounds up to a number an axis can show', () => {
    expect(niceMax(0)).toBe(4);
    expect(niceMax(3)).toBe(4);
    expect(niceMax(5)).toBe(6);
    expect(niceMax(7)).toBe(8);
    expect(niceMax(13)).toBe(20);
    expect(niceMax(21)).toBe(30);
    expect(niceMax(48)).toBe(50);
    expect(niceMax(100)).toBe(100);
    expect(niceMax(109)).toBe(120);
    expect(niceMax(950)).toBe(1000);
  });

  it('always has a whole number at half way', () => {
    for (let value = 1; value <= 5000; value += 1) {
      const top = niceMax(value);
      expect(top).toBeGreaterThanOrEqual(value);
      expect(Number.isInteger(top / 2)).toBe(true);
    }
  });
});

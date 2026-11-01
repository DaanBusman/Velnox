import { describe, expect, it } from 'vitest';
import type { ClusterResource } from '@velnox/proxmox';
import { liveFingerprint, watchedIntervals } from './live';

const A = '7aca66b8-fce5-46e1-be80-46e89221de55';
const B = '3d8c7c82-fd61-4549-bc5f-a413f1b8da2b';

describe('watchedIntervals', () => {
  it('takes the most eager viewer of each cluster', () => {
    const wanted = watchedIntervals([`${A}:30`, `${A}:2`, `${B}:10`]);
    expect(wanted.get(A)).toBe(2);
    expect(wanted.get(B)).toBe(10);
  });

  it('ignores what it does not recognise, and anything faster than two seconds', () => {
    const wanted = watchedIntervals(['nonsense', `${A}:0`, `${A}:1`, `not-a-uuid:5`]);
    expect(wanted.size).toBe(0);
  });
});

describe('liveFingerprint', () => {
  const node: ClusterResource = {
    id: 'node/pve1',
    type: 'node',
    node: 'pve1',
    status: 'online',
    cpu: 0.1234,
    maxcpu: 8,
    mem: 4_000_000_000,
    maxmem: 16_000_000_000,
    uptime: 1000,
  };
  const vm: ClusterResource = {
    id: 'qemu/100',
    type: 'qemu',
    node: 'pve1',
    vmid: 100,
    name: 'web',
    status: 'running',
    cpu: 0.02,
    mem: 1_000_000_000,
    maxmem: 2_000_000_000,
    uptime: 500,
  };

  it('is the same when only what a screen does not show moved', () => {
    const later = [
      { ...vm, uptime: 560, cpu: 0.021, mem: 1_000_100_000 },
      { ...node, uptime: 1060, cpu: 0.1201 },
    ];
    expect(liveFingerprint(later)).toBe(liveFingerprint([node, vm]));
  });

  it('differs when a guest stops, moves or is renamed, or usage moves a visible step', () => {
    const before = liveFingerprint([node, vm]);
    expect(liveFingerprint([node, { ...vm, status: 'stopped' }])).not.toBe(before);
    expect(liveFingerprint([node, { ...vm, node: 'pve2' }])).not.toBe(before);
    expect(liveFingerprint([node, { ...vm, name: 'web-1' }])).not.toBe(before);
    expect(liveFingerprint([{ ...node, cpu: 0.2 }, vm])).not.toBe(before);
    expect(liveFingerprint([node, { ...vm, mem: 1_500_000_000 }])).not.toBe(before);
    expect(liveFingerprint([node])).not.toBe(before);
  });
});

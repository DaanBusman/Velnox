import { describe, expect, it } from 'vitest';
import { blockerOf, chooseTarget, storagesOf } from './guests';

const shared = (storage: string) => storage === 'ceph-vm' || storage === 'nfs';

describe('storagesOf', () => {
  it('reads a VM’s disks, not its CD drives', () => {
    expect(
      storagesOf('qemu', {
        scsi0: 'ceph-vm:vm-100-disk-0,size=32G',
        efidisk0: 'local-lvm:vm-100-disk-1,size=4M',
        ide2: 'local:iso/debian.iso,media=cdrom',
        net0: 'virtio=BC:24:11:00:00:01,bridge=vmbr0',
      }).sort(),
    ).toEqual(['ceph-vm', 'local-lvm']);
  });

  it('reads a container’s root and mount points, a bind mount as the host’s', () => {
    expect(
      storagesOf('lxc', {
        rootfs: 'ceph-vm:subvol-200-disk-0,size=8G',
        mp0: '/srv/data,mp=/data',
      }).sort(),
    ).toEqual(['(host path)', 'ceph-vm']);
  });
});

describe('blockerOf', () => {
  it('lets a guest on shared storage move', () => {
    expect(blockerOf('qemu', { scsi0: 'ceph-vm:vm-1-disk-0' }, shared)).toBeNull();
  });

  it('names a disk only its node sees', () => {
    expect(blockerOf('qemu', { scsi0: 'local:102/vm-102-disk-0.qcow2' }, shared)).toMatch(/local/);
  });

  it('names a passed-through device', () => {
    expect(blockerOf('qemu', { scsi0: 'ceph-vm:x', hostpci0: '0000:01:00.0' }, shared)).toMatch(
      /hostpci0/,
    );
  });
});

describe('chooseTarget', () => {
  const guest = (memoryBytes: number) => ({
    vmid: 1,
    kind: 'qemu' as const,
    name: null,
    node: 'pve1',
    memoryBytes,
    blocker: null,
  });

  it('takes the node with the most room, outside the group, and books the room', () => {
    const free = new Map([
      ['pve1', 100],
      ['pve2', 40],
      ['pve3', 60],
    ]);
    expect(chooseTarget(guest(30), free, new Set(['pve1']))).toBe('pve3');
    expect(free.get('pve3')).toBe(30);
    expect(chooseTarget(guest(30), free, new Set(['pve1']))).toBe('pve2');
  });

  it('finds none when nothing fits, and respects what placement allows', () => {
    const free = new Map([['pve2', 10]]);
    expect(chooseTarget(guest(30), free, new Set(['pve1']))).toBeNull();
    expect(
      chooseTarget(
        guest(5),
        new Map([
          ['pve2', 50],
          ['pve3', 50],
        ]),
        new Set(),
        (n) => n !== 'pve3',
      ),
    ).toBe('pve2');
  });
});

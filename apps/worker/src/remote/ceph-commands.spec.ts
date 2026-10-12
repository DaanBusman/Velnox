import { describe, expect, it } from 'vitest';
import { CEPH_MATRIX } from '@velnox/shared';
import { CEPH_COMMANDS, cephRepoCommand, cephRequireReleaseCommand, commandLine } from './commands';

describe('Ceph commands', () => {
  const squid = CEPH_MATRIX.find((e) => e.to === 'squid')!;

  it('writes exactly Proxmox’s repository line, keeping the old file', () => {
    const line = commandLine(cephRepoCommand(squid, 'no-subscription'), 'pve1', 'velnox');
    expect(line).toContain('sudo -n sh -c ');
    expect(line).toContain(
      'deb http://download.proxmox.com/debian/ceph-squid bookworm no-subscription',
    );
    expect(line).toContain('ceph.list.velnox-before');
  });

  it('raises require-osd-release only to a release it knows', () => {
    expect(commandLine(cephRequireReleaseCommand('squid'), 'pve1', 'root')).toMatch(
      / ceph osd require-osd-release squid$/,
    );
  });

  it('is a closed list, one per matrix step and channel and per release', () => {
    expect(CEPH_COMMANDS.map((c) => c.id)).toEqual([
      'ceph.repository.reef.no-subscription',
      'ceph.repository.reef.enterprise',
      'ceph.repository.squid.no-subscription',
      'ceph.repository.squid.enterprise',
      'ceph.require_osd_release.quincy',
      'ceph.require_osd_release.reef',
      'ceph.require_osd_release.squid',
    ]);
  });
});

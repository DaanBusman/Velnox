import { describe, expect, it } from 'vitest';
import {
  CEPH_MAJOR_PLAYBOOK,
  assessCephHealth,
  cephRepoLine,
  checkMatrix,
  releaseOf,
} from './ceph';
import { playbookProblems } from './upgrade';

describe('releaseOf', () => {
  it('reads the release from any way Ceph writes a version', () => {
    expect(releaseOf('18.2.4')).toBe('reef');
    expect(releaseOf('18.2.4-pve3')).toBe('reef');
    expect(releaseOf('ceph version 19.2.0 (abc) squid (stable)')).toBe('squid');
    expect(releaseOf('16.2.15')).toBeNull();
    expect(releaseOf(null)).toBeNull();
  });
});

describe('checkMatrix', () => {
  const reef = Array(10).fill('18.2.4');

  it('agrees for reef to squid, and names the matrix entry', () => {
    const outcome = checkMatrix(reef, 'squid');
    expect(outcome).toMatchObject({ ok: true, from: 'reef', entry: { repo: 'ceph-squid' } });
  });

  it('names the running release when it is unknown, mixed or too old', () => {
    expect(checkMatrix(['16.2.15', '16.2.15'], 'squid')).toMatchObject({
      ok: false,
      unexpected: 'running',
    });
    expect(checkMatrix(['18.2.4', '19.2.0'], 'squid')).toMatchObject({
      ok: false,
      unexpected: 'running',
      reason: expect.stringContaining('mid-upgrade'),
    });
    expect(checkMatrix(['18.2.2'], 'squid')).toMatchObject({ ok: false, unexpected: 'running' });
  });

  it('names the target when it is unknown or not newer', () => {
    expect(checkMatrix(reef, 'tentacle')).toMatchObject({ ok: false, unexpected: 'target' });
    expect(checkMatrix(reef, 'reef')).toMatchObject({ ok: false, unexpected: 'target' });
  });

  it('names the matrix when both are known but it has no such step', () => {
    expect(checkMatrix(['17.2.7'], 'squid')).toMatchObject({
      ok: false,
      unexpected: 'matrix',
      reason: expect.stringContaining('from quincy it goes to reef'),
    });
  });
});

describe('assessCephHealth', () => {
  const clean = {
    health: { status: 'HEALTH_OK', checks: {} },
    monmap: { mons: [{ name: 'pve1' }, { name: 'pve2' }] },
    quorum_names: ['pve1', 'pve2'],
    pgmap: { pgs_by_state: [{ state_name: 'active+clean', count: 128 }] },
  };

  it('is whole when healthy, clean and quorate', () => {
    expect(assessCephHealth(clean, false).ok).toBe(true);
  });

  it('allows the warnings the upgrade itself causes, only while upgrading', () => {
    const noout = {
      ...clean,
      health: {
        status: 'HEALTH_WARN',
        checks: {
          OSDMAP_FLAGS: { severity: 'HEALTH_WARN', summary: { message: 'noout flag(s) set' } },
        },
      },
    };
    expect(assessCephHealth(noout, true).ok).toBe(true);
    expect(assessCephHealth(noout, false).ok).toBe(false);
  });

  it('knows what a restart causes for a moment, and waits rather than calling it unknown', () => {
    const restarting = {
      ...clean,
      quorum_names: ['pve2'],
      health: {
        status: 'HEALTH_WARN',
        checks: {
          MON_DOWN: { severity: 'HEALTH_WARN', summary: { message: '1/2 mons down, quorum pve2' } },
        },
      },
    };
    const result = assessCephHealth(restarting, true);
    expect(result.ok).toBe(false);
    expect(result.unknown).toEqual([]);
    expect(result.problems[0]).toMatch(/^MON_DOWN/);
  });

  it('stops on an unrecognised warning, unclean PGs, or a monitor out of quorum', () => {
    const odd = {
      ...clean,
      health: {
        status: 'HEALTH_WARN',
        checks: {
          DEVICE_HEALTH: {
            severity: 'HEALTH_WARN',
            summary: { message: '1 device has a predicted failure' },
          },
        },
      },
    };
    expect(assessCephHealth(odd, true)).toMatchObject({
      ok: false,
      unknown: ['DEVICE_HEALTH: 1 device has a predicted failure'],
    });
    expect(
      assessCephHealth(
        {
          ...clean,
          pgmap: { pgs_by_state: [{ state_name: 'active+undersized+degraded', count: 3 }] },
        },
        true,
      ).problems,
    ).toEqual(['3 placement groups are not active+clean (3 active+undersized+degraded)']);
    expect(assessCephHealth({ ...clean, quorum_names: ['pve1'] }, true).problems).toEqual([
      'monitor pve2 not in quorum',
    ]);
  });
});

describe('the Ceph playbook', () => {
  it('is well formed and writes Proxmox’s own repository lines', () => {
    expect(playbookProblems(CEPH_MAJOR_PLAYBOOK)).toEqual([]);
    expect(cephRepoLine({ repo: 'ceph-squid', suite: 'bookworm' }, 'no-subscription')).toBe(
      'deb http://download.proxmox.com/debian/ceph-squid bookworm no-subscription',
    );
    expect(cephRepoLine({ repo: 'ceph-squid', suite: 'bookworm' }, 'enterprise')).toBe(
      'deb https://enterprise.proxmox.com/debian/ceph-squid bookworm enterprise',
    );
  });
});

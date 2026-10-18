import { describe, expect, it } from 'vitest';
import type { RepositoryInfo } from './client';
import { isEmptyChange, planNoSubscription } from './repositories';

/**
 * Proxmox VE 8 writes one-line .list files, 9 writes deb822 .sources; the API
 * reports both the same way, so both shapes are here. What must never happen:
 * a node with a subscription touched, or an enterprise repository turned off
 * without its no-subscription one on.
 */
const pve8: RepositoryInfo = {
  digest: 'd',
  files: [
    {
      path: '/etc/apt/sources.list',
      repositories: [
        {
          Enabled: 1,
          URIs: ['http://ftp.debian.org/debian'],
          Suites: ['bookworm'],
          Components: ['main'],
        },
      ],
    },
    {
      path: '/etc/apt/sources.list.d/pve-enterprise.list',
      repositories: [
        {
          Enabled: 1,
          URIs: ['https://enterprise.proxmox.com/debian/pve'],
          Suites: ['bookworm'],
          Components: ['pve-enterprise'],
        },
      ],
    },
    {
      path: '/etc/apt/sources.list.d/ceph.list',
      repositories: [
        {
          Enabled: 1,
          URIs: ['https://enterprise.proxmox.com/debian/ceph-squid'],
          Suites: ['bookworm'],
          Components: ['enterprise'],
        },
      ],
    },
  ],
};

const pve9: RepositoryInfo = {
  digest: 'd',
  files: [
    {
      path: '/etc/apt/sources.list.d/pve-enterprise.sources',
      'file-type': 'sources',
      repositories: [
        {
          Enabled: 1,
          URIs: ['https://enterprise.proxmox.com/debian/pve'],
          Suites: ['trixie'],
          Components: ['pve-enterprise'],
        },
      ],
    },
    {
      path: '/etc/apt/sources.list.d/proxmox.sources',
      'file-type': 'sources',
      repositories: [
        {
          Enabled: 0,
          URIs: ['http://download.proxmox.com/debian/pve'],
          Suites: ['trixie'],
          Components: ['pve-no-subscription'],
        },
      ],
    },
  ],
};

describe('a node without a subscription', () => {
  it('on PVE 8: enterprise off, no-subscription added, for Proxmox VE and for Ceph', () => {
    const change = planNoSubscription(pve8, null);
    expect(change.toggle.map((t) => [t.path, t.index, t.enabled])).toEqual([
      ['/etc/apt/sources.list.d/pve-enterprise.list', 0, false],
      ['/etc/apt/sources.list.d/ceph.list', 0, false],
    ]);
    expect(change.add.map((a) => a.handle)).toEqual([
      'no-subscription',
      'ceph-squid-no-subscription',
    ]);
  });

  it('on PVE 9: enterprise off, and the no-subscription repository that is there but off, on', () => {
    const change = planNoSubscription(pve9, { status: 'notfound' });
    expect(change.toggle.map((t) => [t.path, t.enabled])).toEqual([
      ['/etc/apt/sources.list.d/pve-enterprise.sources', false],
      ['/etc/apt/sources.list.d/proxmox.sources', true],
    ]);
    expect(change.add).toEqual([]);
  });

  it('an expired subscription counts as none', () => {
    expect(isEmptyChange(planNoSubscription(pve8, { status: 'expired' }))).toBe(false);
  });

  it('nothing to do once the enterprise repository is already off', () => {
    const done: RepositoryInfo = {
      files: [
        {
          path: '/etc/apt/sources.list.d/pve-enterprise.list',
          repositories: [
            {
              Enabled: 0,
              URIs: ['https://enterprise.proxmox.com/debian/pve'],
              Components: ['pve-enterprise'],
            },
          ],
        },
      ],
    };
    expect(isEmptyChange(planNoSubscription(done, null))).toBe(true);
  });
});

describe('a node with a subscription', () => {
  it('is never touched', () => {
    expect(isEmptyChange(planNoSubscription(pve8, { status: 'active', level: 'c' }))).toBe(true);
    expect(isEmptyChange(planNoSubscription(pve9, { status: 'active' }))).toBe(true);
  });
});

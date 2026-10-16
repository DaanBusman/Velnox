import { describe, expect, it } from 'vitest';
import { mergeCandidates, sameProxmoxCluster } from './cluster-merge';

/**
 * Merging removes a registration, so what counts as "the same cluster" is
 * the line between tidying up and losing a customer's cluster from Velnox.
 */
const c = (id: string, pveClusterName: string | null, nodes: string[], tenantId = 't1') => ({
  id,
  tenantId,
  pveClusterName,
  nodes,
});

describe('one Proxmox cluster, registered twice', () => {
  it('is the same name from Proxmox and nodes in common', () => {
    expect(
      sameProxmoxCluster(
        c('a', 'PVE-PROD', ['pve1', 'pve2']),
        c('b', 'PVE-PROD', ['pve1', 'pve2']),
      ),
    ).toBe(true);
  });

  it('is not two standalone servers that are both called pve', () => {
    expect(sameProxmoxCluster(c('a', null, ['pve']), c('b', null, ['pve']))).toBe(false);
  });

  it('is not two clusters that happen to share a name but no node', () => {
    expect(sameProxmoxCluster(c('a', 'lab', ['pve1']), c('b', 'lab', ['pve9']))).toBe(false);
  });

  it('is never across tenants, nor a cluster with itself', () => {
    expect(sameProxmoxCluster(c('a', 'X', ['n']), c('b', 'X', ['n'], 't2'))).toBe(false);
    expect(sameProxmoxCluster(c('a', 'X', ['n']), c('a', 'X', ['n']))).toBe(false);
  });

  it('groups three registrations of one cluster together, and leaves the rest', () => {
    const groups = mergeCandidates([
      c('a', 'PROD', ['p1']),
      c('b', 'PROD', ['p1', 'p2']),
      c('x', null, ['pve']),
      c('d', 'PROD', ['p2']),
    ]);
    expect(groups.map((g) => g.map((x) => x.id))).toEqual([['a', 'b', 'd']]);
  });
});

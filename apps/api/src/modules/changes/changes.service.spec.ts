import { describe, expect, it } from 'vitest';
import { PERMISSIONS, type ChangeMessage, type Grant } from '@velnox/shared';
import { parseChange } from './change.hub';
import { mayHear } from './changes.service';

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const S1 = '33333333-3333-4333-8333-333333333333';
const C1 = '44444444-4444-4444-8444-444444444444';
const C2 = '55555555-5555-4555-8555-555555555555';

const inventory = (clusterId: string, tenantId = T1, siteId: string | null = S1): ChangeMessage => ({
  topic: 'inventory',
  tenantId,
  siteId,
  clusterId,
});
const jobs = (tenantId: string): ChangeMessage => ({ topic: 'jobs', tenantId, siteId: null, clusterId: null });

describe('mayHear', () => {
  it('passes a change on only at the scope reading it would need', () => {
    const tenant: Grant[] = [{ permission: PERMISSIONS.clustersRead, scopeType: 'TENANT', scopeId: T1 }];
    expect(mayHear(tenant, inventory(C1))).toBe(true);
    expect(mayHear(tenant, inventory(C2, T2, null))).toBe(false);

    const cluster: Grant[] = [{ permission: PERMISSIONS.workloadsRead, scopeType: 'CLUSTER', scopeId: C1 }];
    expect(mayHear(cluster, inventory(C1))).toBe(true);
    expect(mayHear(cluster, inventory(C2))).toBe(false);

    const site: Grant[] = [{ permission: PERMISSIONS.nodesRead, scopeType: 'SITE', scopeId: S1 }];
    expect(mayHear(site, inventory(C2))).toBe(true);
    expect(mayHear(site, inventory(C2, T1, null))).toBe(false);
  });

  it('needs jobs.read in the job\'s tenant for a job, and nothing less', () => {
    const reader: Grant[] = [{ permission: PERMISSIONS.jobsRead, scopeType: 'TENANT', scopeId: T1 }];
    expect(mayHear(reader, jobs(T1))).toBe(true);
    expect(mayHear(reader, jobs(T2))).toBe(false);
    // Reading clusters is not reading jobs.
    const clusters: Grant[] = [{ permission: PERMISSIONS.clustersRead, scopeType: 'TENANT', scopeId: T1 }];
    expect(mayHear(clusters, jobs(T1))).toBe(false);
  });

  it('hears everything with a global grant, and nothing with none', () => {
    const global: Grant[] = [
      { permission: PERMISSIONS.jobsRead, scopeType: 'GLOBAL', scopeId: null },
      { permission: PERMISSIONS.clustersRead, scopeType: 'GLOBAL', scopeId: null },
    ];
    expect(mayHear(global, jobs(T2))).toBe(true);
    expect(mayHear(global, inventory(C2, T2, null))).toBe(true);
    expect(mayHear([], jobs(T1))).toBe(false);
  });
});

describe('parseChange', () => {
  it('reads a change as the worker publishes it', () => {
    expect(parseChange(JSON.stringify(inventory(C1)))).toEqual(inventory(C1));
  });

  it('refuses anything else rather than guessing', () => {
    expect(parseChange('not json')).toBeNull();
    expect(parseChange(JSON.stringify({ ...inventory(C1), topic: 'secrets' }))).toBeNull();
    expect(parseChange(JSON.stringify({ ...inventory(C1), tenantId: 'x' }))).toBeNull();
    expect(parseChange(JSON.stringify({ topic: 'jobs', tenantId: T1 }))).toBeNull();
  });
});

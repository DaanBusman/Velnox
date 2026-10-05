import 'server-only';
import type { ClusterSummary, TenantSummary } from '@/lib/session-types';
import { listClusters, listTenants } from '@/lib/session';
import { resolveSelection, selectedTenantId } from '@/lib/tenant-selection';

/**
 * Which tenant and cluster a per-cluster page shows.
 *
 * Networks and storage are read one cluster at a time, inside one tenant — the
 * MSP's own included. So a tenant has to be chosen: the one selected in the top
 * bar, or the only one the viewer reaches. With "all tenants" selected the page
 * asks for one instead of mixing customers. The cluster is the one named in the
 * address (`?cluster=`) if it belongs to that tenant, or else the first by name.
 */
export type ClusterScope =
  | { state: 'failed'; code: string }
  | { state: 'pick-tenant'; tenants: TenantSummary[] }
  | { state: 'no-clusters'; tenant: TenantSummary }
  | { state: 'ready'; tenant: TenantSummary; clusters: ClusterSummary[]; cluster: ClusterSummary };

export async function resolveClusterScope(requested: string | undefined): Promise<ClusterScope> {
  const [tenants, selected] = await Promise.all([listTenants(), selectedTenantId()]);
  if (!tenants.ok) return { state: 'failed', code: tenants.code };

  const reachable = tenants.data.tenants.filter((tenant) => tenant.status !== 'ARCHIVED');
  const chosen =
    resolveSelection(selected, reachable) ?? (reachable.length === 1 ? reachable[0]!.id : null);
  const tenant = reachable.find((candidate) => candidate.id === chosen);
  if (!tenant) return { state: 'pick-tenant', tenants: reachable };

  const clusters = await listClusters({ tenantId: tenant.id });
  if (!clusters.ok) return { state: 'failed', code: clusters.code };
  const own = clusters.data.clusters
    .filter((cluster) => cluster.tenantId === tenant.id)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (own.length === 0) return { state: 'no-clusters', tenant };

  const cluster = own.find((candidate) => candidate.id === requested) ?? own[0]!;
  return { state: 'ready', tenant, clusters: own, cluster };
}

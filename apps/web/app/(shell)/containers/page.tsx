import { getTranslations } from 'next-intl/server';
import { Notice, PageHeader } from '@/components/ui/primitives';
import { WorkloadTable } from '@/components/inventory/tables';
import { listClusters, listWorkloads } from '@/lib/session';
import { resolveSelection, selectedTenantId } from '@/lib/tenant-selection';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('nav.containers') };
}

export default async function Page() {
  const [t, selected] = await Promise.all([getTranslations(), selectedTenantId()]);

  /*
   * Guests are filtered by cluster, not by tenant, because that is the only
   * filter the endpoint takes — so the tenant selection is resolved into the
   * clusters it covers first. An empty list of clusters means an empty list of
   * guests, which is the correct answer rather than "everything".
   */
  const clusters = await listClusters({ tenantId: null });
  const tenantId = resolveSelection(
    selected,
    clusters.ok
      ? [...new Set(clusters.data.clusters.map((cluster) => cluster.tenantId))].map((id) => ({ id }))
      : [],
  );

  const workloads = await listWorkloads({ kind: 'LXC' });

  if (!workloads.ok) {
    return (
      <>
        <PageHeader title={t('nav.containers')} />
        <Notice tone={workloads.code === 'authz.forbidden' ? 'warn' : 'error'}>
          {workloads.code === 'authz.forbidden'
            ? t('common.requiresPermission', { permission: 'workloads.read' })
            : t('errors.generic')}
        </Notice>
      </>
    );
  }

  const visible = tenantId
    ? workloads.data.workloads.filter((workload) =>
        clusters.ok
          ? clusters.data.clusters.some(
              (cluster) => cluster.id === workload.clusterId && cluster.tenantId === tenantId,
            )
          : true,
      )
    : workloads.data.workloads;

  return (
    <>
      <PageHeader title={t('nav.containers')} description={t('inventory.ctPageDescription')} />
      <WorkloadTable
        workloads={visible}
        title={t('nav.containers')}
        description={t('inventory.workloadsSubtitle')}
      />
    </>
  );
}

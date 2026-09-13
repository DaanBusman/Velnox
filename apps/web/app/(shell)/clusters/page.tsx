import { getTranslations } from 'next-intl/server';
import { Notice, PageHeader } from '@/components/ui/primitives';
import { ClusterAdmin } from '@/components/inventory/cluster-admin';
import { getSession, listClusters, listSites, listTenants } from '@/lib/session';
import { resolveSelection, selectedTenantId } from '@/lib/tenant-selection';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('nav.clusters') };
}

export default async function ClustersPage() {
  const [t, session, tenants, selected] = await Promise.all([
    getTranslations(),
    getSession(),
    listTenants(),
    selectedTenantId(),
  ]);

  const selectable = tenants.ok ? tenants.data.tenants : [];
  const tenantId = resolveSelection(selected, selectable);

  const [clusters, sites] = await Promise.all([listClusters({ tenantId }), listSites(tenantId)]);

  if (!clusters.ok) {
    return (
      <>
        <PageHeader title={t('nav.clusters')} />
        <Notice tone={clusters.code === 'authz.forbidden' ? 'warn' : 'error'}>
          {clusters.code === 'authz.forbidden'
            ? t('common.requiresPermission', { permission: 'clusters.read' })
            : t('errors.generic')}
        </Notice>
      </>
    );
  }

  const permissions = new Set(session?.user.permissions ?? []);

  return (
    <>
      <PageHeader title={t('nav.clusters')} description={t('clusters.pageDescription')} />
      <ClusterAdmin
        clusters={clusters.data.clusters}
        tenants={selectable}
        sites={sites.ok ? sites.data.sites : []}
        canManage={permissions.has('clusters.manage')}
      />
    </>
  );
}

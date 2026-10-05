import { getTranslations } from 'next-intl/server';
import { Notice, PageHeader } from '@/components/ui/primitives';
import { TenantSelector } from '@/components/tenant-selector';
import type { ClusterScope } from '@/lib/cluster-scope';
import { ClusterPicker } from './cluster-scope-bar';

/**
 * The frame of a per-cluster page: the header, then either what still has to
 * be chosen (a tenant, or a tenant with clusters) or the picker and the page.
 */
export async function ClusterScopePage({
  title,
  description,
  scope,
  permission,
  children,
}: {
  title: string;
  description: string;
  scope: ClusterScope;
  permission: string;
  children: React.ReactNode;
}) {
  const t = await getTranslations();

  return (
    <>
      <PageHeader title={title} description={description} />
      {scope.state === 'failed' ? (
        <Notice tone={scope.code === 'authz.forbidden' ? 'warn' : 'error'}>
          {scope.code === 'authz.forbidden'
            ? t('common.requiresPermission', { permission })
            : t('errors.generic')}
        </Notice>
      ) : scope.state === 'pick-tenant' ? (
        <Notice tone="neutral" title={t('inventory.scopePickTenantTitle')}>
          <p className="mb-3">{t('inventory.scopePickTenantBody')}</p>
          <TenantSelector
            tenants={scope.tenants.map((tenant) => ({
              id: tenant.id,
              name: tenant.name,
              kind: tenant.kind,
            }))}
            selected={null}
          />
        </Notice>
      ) : scope.state === 'no-clusters' ? (
        <Notice tone="neutral">
          {t('inventory.scopeNoClusters', { tenant: scope.tenant.name })}
        </Notice>
      ) : (
        <>
          <ClusterPicker
            tenantName={scope.tenant.name}
            clusters={scope.clusters.map((cluster) => ({ id: cluster.id, name: cluster.name }))}
            selected={scope.cluster.id}
          />
          {children}
        </>
      )}
    </>
  );
}

import { getTranslations } from 'next-intl/server';
import { Notice, PageHeader } from '@/components/ui/primitives';
import { SiteAdmin } from '@/components/site-admin';
import { getSession, listSites, listTenants } from '@/lib/session';
import { resolveSelection, selectedTenantId } from '@/lib/tenant-selection';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('nav.sites') };
}

export default async function SitesPage() {
  const [t, session, tenants, selected] = await Promise.all([
    getTranslations(),
    getSession(),
    listTenants(),
    selectedTenantId(),
  ]);

  /*
   * The selection is resolved against the tenants this account can actually
   * reach, so a cookie left behind by an archived tenant does not silently
   * filter the page down to nothing.
   */
  const selectable = tenants.ok ? tenants.data.tenants : [];
  const tenantId = resolveSelection(selected, selectable);

  const sites = await listSites(tenantId);

  if (!sites.ok) {
    return (
      <>
        <PageHeader title={t('nav.sites')} />
        <Notice tone={sites.code === 'authz.forbidden' ? 'warn' : 'error'}>
          {sites.code === 'authz.forbidden'
            ? t('common.requiresPermission', { permission: 'sites.read' })
            : t('errors.generic')}
        </Notice>
      </>
    );
  }

  const permissions = new Set(session?.user.permissions ?? []);

  return (
    <>
      <PageHeader
        title={t('nav.sites')}
        description={
          tenantId
            ? t('sites.filteredBy', {
                tenant: selectable.find((tenant) => tenant.id === tenantId)?.name ?? '',
              })
            : t('sites.pageDescription')
        }
      />
      <SiteAdmin
        sites={sites.data.sites}
        tenants={selectable}
        canManage={permissions.has('sites.manage')}
        defaultTenantId={tenantId}
      />
    </>
  );
}

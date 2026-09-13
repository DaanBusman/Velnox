import { getTranslations } from 'next-intl/server';
import { Notice, PageHeader } from '@/components/ui/primitives';
import { TenantAdmin } from '@/components/tenant-admin';
import { getSession, listTenants } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('nav.tenants') };
}

export default async function TenantsPage() {
  const [t, session, tenants] = await Promise.all([
    getTranslations(),
    getSession(),
    listTenants(),
  ]);

  if (!tenants.ok) {
    return (
      <>
        <PageHeader title={t('nav.tenants')} />
        <Notice tone={tenants.code === 'authz.forbidden' ? 'warn' : 'error'}>
          {tenants.code === 'authz.forbidden'
            ? t('common.requiresPermission', { permission: 'tenants.read' })
            : t('errors.generic')}
        </Notice>
      </>
    );
  }

  /*
   * What to offer comes from the permissions the API reported for this session.
   * The API refuses the call either way; this only decides whether someone is
   * shown a control that would always be refused.
   */
  const permissions = new Set(session?.user.permissions ?? []);

  return (
    <>
      <PageHeader title={t('nav.tenants')} description={t('tenants.pageDescription')} />
      <TenantAdmin
        tenants={tenants.data.tenants}
        canManage={permissions.has('tenants.manage')}
        currentTenantId={session?.user.tenantId ?? null}
      />
    </>
  );
}

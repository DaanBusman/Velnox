import { getTranslations } from 'next-intl/server';
import { Notice, PageHeader } from '@/components/ui/primitives';
import { PackagesView } from '@/components/autoconfig/packages-view';
import { getSession, listTenants } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('autoconfig.packagesTitle') };
}

export default async function PackagesPage({
  searchParams,
}: {
  searchParams: Promise<{ tenantId?: string }>;
}) {
  const { tenantId } = await searchParams;
  const [t, session, tenants] = await Promise.all([getTranslations(), getSession(), listTenants()]);
  const permissions = new Set(session?.user.permissions ?? []);

  return (
    <>
      <PageHeader
        title={t('autoconfig.packagesTitle')}
        description={t('autoconfig.packagesSubtitle')}
      />
      {permissions.has('autoconfig.read') ? (
        <PackagesView
          tenants={tenants.ok ? tenants.data.tenants : []}
          initialTenantId={tenantId ?? null}
          canManage={permissions.has('autoconfig.manage')}
        />
      ) : (
        <Notice tone="warn">
          {t('common.requiresPermission', { permission: 'autoconfig.read' })}
        </Notice>
      )}
    </>
  );
}

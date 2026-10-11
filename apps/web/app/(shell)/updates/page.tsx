import { getTranslations } from 'next-intl/server';
import { Notice, PageHeader } from '@/components/ui/primitives';
import { UpdatesView } from '@/components/updates/updates-view';
import { getSession, listClusters, listTenants } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('nav.updates') };
}

export default async function UpdatesPage() {
  const [t, session, clusters, tenants] = await Promise.all([
    getTranslations(),
    getSession(),
    listClusters(),
    listTenants(),
  ]);
  const permissions = new Set(session?.user.permissions ?? []);

  return (
    <>
      <PageHeader title={t('nav.updates')} description={t('nodeUpdates.subtitle')} />
      {permissions.has('updates.read') ? (
        <UpdatesView
          clusters={clusters.ok ? clusters.data.clusters : []}
          tenants={tenants.ok ? tenants.data.tenants : []}
          canExecute={permissions.has('updates.execute')}
          canManage={permissions.has('updates.manage')}
        />
      ) : (
        <Notice tone="warn">
          {t('common.requiresPermission', { permission: 'updates.read' })}
        </Notice>
      )}
    </>
  );
}

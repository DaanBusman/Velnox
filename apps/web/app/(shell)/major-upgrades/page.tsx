import { getTranslations } from 'next-intl/server';
import { Notice, PageHeader } from '@/components/ui/primitives';
import { UpdatesView } from '@/components/updates/updates-view';
import { getSession, listClusters, listTenants } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('nav.majorUpgrades') };
}

/** Major upgrades: the same destination as updates, opened on its own tab. */
export default async function MajorUpgradesPage() {
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
      {permissions.has('updates.read') || permissions.has('upgrades.read') ? (
        <UpdatesView
          clusters={clusters.ok ? clusters.data.clusters : []}
          tenants={tenants.ok ? tenants.data.tenants : []}
          canExecute={permissions.has('updates.execute')}
          canManage={permissions.has('updates.manage')}
          canUpgrade={permissions.has('upgrades.execute')}
          initialTab="upgrades"
        />
      ) : (
        <Notice tone="warn">
          {t('common.requiresPermission', { permission: 'upgrades.read' })}
        </Notice>
      )}
    </>
  );
}

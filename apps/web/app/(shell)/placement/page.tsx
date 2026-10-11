import { getTranslations } from 'next-intl/server';
import { Notice, PageHeader } from '@/components/ui/primitives';
import { PlacementView } from '@/components/placement/placement-view';
import { getSession, listClusters } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('nav.placement') };
}

export default async function PlacementPage() {
  const [t, session, clusters] = await Promise.all([
    getTranslations(),
    getSession(),
    listClusters(),
  ]);
  const permissions = new Set(session?.user.permissions ?? []);

  return (
    <>
      <PageHeader title={t('nav.placement')} description={t('placement.subtitle')} />
      {permissions.has('placement.read') ? (
        <PlacementView clusters={clusters.ok ? clusters.data.clusters : []} />
      ) : (
        <Notice tone="warn">
          {t('common.requiresPermission', { permission: 'placement.read' })}
        </Notice>
      )}
    </>
  );
}

import { getTranslations } from 'next-intl/server';
import { Notice } from '@/components/ui/primitives';
import { StorageTable } from '@/components/inventory/tables';
import { ClusterScopePage } from '@/components/inventory/cluster-scope-page';
import { resolveClusterScope } from '@/lib/cluster-scope';
import { listStorages } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('nav.storage') };
}

/** One cluster's storage, across its nodes, in the chosen tenant. */
export default async function StoragePage({
  searchParams,
}: {
  searchParams: Promise<{ cluster?: string }>;
}) {
  const [t, { cluster }] = await Promise.all([getTranslations(), searchParams]);
  const scope = await resolveClusterScope(cluster);
  const storages =
    scope.state === 'ready' ? await listStorages({ clusterId: scope.cluster.id }) : null;

  return (
    <ClusterScopePage
      title={t('nav.storage')}
      description={t('inventory.storagePageDescription')}
      scope={scope}
      permission="storage.read"
    >
      {storages && !storages.ok ? (
        <Notice tone={storages.code === 'authz.forbidden' ? 'warn' : 'error'}>
          {storages.code === 'authz.forbidden'
            ? t('common.requiresPermission', { permission: 'storage.read' })
            : t('errors.generic')}
        </Notice>
      ) : (
        storages && <StorageTable storages={storages.data.storages} />
      )}
    </ClusterScopePage>
  );
}

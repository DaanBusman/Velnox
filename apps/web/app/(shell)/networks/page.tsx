import { getTranslations } from 'next-intl/server';
import { Notice } from '@/components/ui/primitives';
import { InterfaceTable } from '@/components/inventory/tables';
import { ClusterScopePage } from '@/components/inventory/cluster-scope-page';
import { resolveClusterScope } from '@/lib/cluster-scope';
import { listInterfaces } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('nav.networks') };
}

/** One cluster's network interfaces, across its nodes, in the chosen tenant. */
export default async function NetworksPage({
  searchParams,
}: {
  searchParams: Promise<{ cluster?: string }>;
}) {
  const [t, { cluster }] = await Promise.all([getTranslations(), searchParams]);
  const scope = await resolveClusterScope(cluster);
  const interfaces =
    scope.state === 'ready' ? await listInterfaces({ clusterId: scope.cluster.id }) : null;

  return (
    <ClusterScopePage
      title={t('nav.networks')}
      description={t('inventory.networksPageDescription')}
      scope={scope}
      permission="networks.read"
    >
      {interfaces && !interfaces.ok ? (
        <Notice tone={interfaces.code === 'authz.forbidden' ? 'warn' : 'error'}>
          {interfaces.code === 'authz.forbidden'
            ? t('common.requiresPermission', { permission: 'networks.read' })
            : t('errors.generic')}
        </Notice>
      ) : (
        interfaces && <InterfaceTable interfaces={interfaces.data.interfaces} />
      )}
    </ClusterScopePage>
  );
}

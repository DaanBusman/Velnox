import { getTranslations } from 'next-intl/server';
import { Notice, PageHeader } from '@/components/ui/primitives';
import { NodeTable } from '@/components/inventory/tables';
import { listNodes, listTenants } from '@/lib/session';
import { resolveSelection, selectedTenantId } from '@/lib/tenant-selection';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('nav.nodes') };
}

export default async function NodesPage() {
  const [t, tenants, selected] = await Promise.all([
    getTranslations(),
    listTenants(),
    selectedTenantId(),
  ]);

  const tenantId = resolveSelection(selected, tenants.ok ? tenants.data.tenants : []);
  const nodes = await listNodes({ tenantId });

  if (!nodes.ok) {
    return (
      <>
        <PageHeader title={t('nav.nodes')} />
        <Notice tone={nodes.code === 'authz.forbidden' ? 'warn' : 'error'}>
          {nodes.code === 'authz.forbidden'
            ? t('common.requiresPermission', { permission: 'nodes.read' })
            : t('errors.generic')}
        </Notice>
      </>
    );
  }

  return (
    <>
      <PageHeader title={t('nav.nodes')} description={t('inventory.nodesPageDescription')} />
      <NodeTable nodes={nodes.data.nodes} />
    </>
  );
}

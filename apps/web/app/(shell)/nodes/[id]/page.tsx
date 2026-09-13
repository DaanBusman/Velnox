import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Notice, PageHeader } from '@/components/ui/primitives';
import { NodeDetailView } from '@/components/inventory/node-detail';
import { getNode } from '@/lib/session';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props) {
  const { id } = await params;
  const node = await getNode(id);
  const t = await getTranslations();
  return { title: node.ok ? node.data.name : t('nav.nodes') };
}

export default async function NodePage({ params }: Props) {
  const { id } = await params;
  const [t, node] = await Promise.all([getTranslations(), getNode(id)]);

  if (!node.ok && node.code === 'not_found') notFound();

  if (!node.ok) {
    return (
      <>
        <PageHeader title={t('nav.nodes')} />
        <Notice tone={node.code === 'authz.forbidden' ? 'warn' : 'error'}>
          {node.code === 'authz.forbidden'
            ? t('common.requiresPermission', { permission: 'nodes.read' })
            : t('errors.generic')}
        </Notice>
      </>
    );
  }

  return (
    <>
      <PageHeader title={node.data.name} description={node.data.clusterName} />
      <NodeDetailView node={node.data} />
    </>
  );
}

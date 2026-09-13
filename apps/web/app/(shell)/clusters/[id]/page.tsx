import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Notice, PageHeader } from '@/components/ui/primitives';
import { ClusterDetail } from '@/components/inventory/cluster-detail';
import {
  getCluster,
  getSession,
  listClusterCeph,
  listDiscoveryRuns,
  listNodes,
  listWorkloads,
} from '@/lib/session';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props) {
  const { id } = await params;
  const cluster = await getCluster(id);
  const t = await getTranslations();
  return { title: cluster.ok ? cluster.data.name : t('nav.clusters') };
}

export default async function ClusterPage({ params }: Props) {
  const { id } = await params;
  const [t, session, cluster] = await Promise.all([
    getTranslations(),
    getSession(),
    getCluster(id),
  ]);

  // A cluster outside this account's scope reads as one that does not exist,
  // which is what the API already answers.
  if (!cluster.ok && cluster.code === 'not_found') notFound();

  if (!cluster.ok) {
    return (
      <>
        <PageHeader title={t('nav.clusters')} />
        <Notice tone={cluster.code === 'authz.forbidden' ? 'warn' : 'error'}>
          {cluster.code === 'authz.forbidden'
            ? t('common.requiresPermission', { permission: 'clusters.read' })
            : t('errors.generic')}
        </Notice>
      </>
    );
  }

  const [nodes, workloads, ceph, runs] = await Promise.all([
    listNodes({ clusterId: id }),
    listWorkloads({ clusterId: id }),
    listClusterCeph(id),
    listDiscoveryRuns(id),
  ]);

  const permissions = new Set(session?.user.permissions ?? []);

  return (
    <>
      <PageHeader
        title={cluster.data.name}
        description={t('clusters.detailDescription', { tenant: cluster.data.tenantName })}
      />
      <ClusterDetail
        cluster={cluster.data}
        nodes={nodes.ok ? nodes.data.nodes : []}
        workloads={workloads.ok ? workloads.data.workloads : []}
        cephDaemons={ceph.ok ? ceph.data.daemons : []}
        runs={runs.ok ? runs.data.runs : []}
        canManage={permissions.has('clusters.manage')}
      />
    </>
  );
}

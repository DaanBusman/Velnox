import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Button } from '@/components/ui/form';
import { Notice, PageHeader } from '@/components/ui/primitives';
import { WorkloadTable } from '@/components/inventory/tables';
import { RefreshWhile } from '@/components/inventory/refresh-while';
import { getSession, listClusters, listProvisionings, listWorkloads } from '@/lib/session';
import { refreshSeconds } from '@/lib/preferences';
import { resolveSelection, selectedTenantId } from '@/lib/tenant-selection';

export const dynamic = 'force-dynamic';

/**
 * How long a failed build stays in the list. Its VM was removed again, so
 * without this the row would vanish without a word; after a day the build
 * history is where to look.
 */
const FAILED_SHOWN_MS = 24 * 60 * 60_000;

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('nav.virtualMachines') };
}

export default async function Page() {
  const [t, selected, session, refresh] = await Promise.all([
    getTranslations(),
    selectedTenantId(),
    getSession(),
    refreshSeconds(),
  ]);
  const permissions = session?.user.permissions ?? [];
  const canProvision = permissions.includes('workloads.provision');

  /*
   * Guests are filtered by cluster, not by tenant, because that is the only
   * filter the endpoint takes — so the tenant selection is resolved into the
   * clusters it covers first. An empty list of clusters means an empty list of
   * guests, which is the correct answer rather than "everything".
   */
  const clusters = await listClusters({ tenantId: null });
  const tenantId = resolveSelection(
    selected,
    clusters.ok
      ? [...new Set(clusters.data.clusters.map((cluster) => cluster.tenantId))].map((id) => ({
          id,
        }))
      : [],
  );

  const [workloads, provisionings] = await Promise.all([
    listWorkloads({ kind: 'QEMU' }),
    listProvisionings(),
  ]);

  const actions = (
    <div className="flex items-center gap-2">
      <Link href="/provisioning">
        <Button variant="quiet">{t('inventory.buildHistory')}</Button>
      </Link>
      {canProvision && (
        <Link href="/provisioning/new">
          <Button>{t('inventory.newVm')}</Button>
        </Link>
      )}
    </div>
  );

  if (!workloads.ok) {
    return (
      <>
        <PageHeader title={t('nav.virtualMachines')} actions={actions} />
        <Notice tone={workloads.code === 'authz.forbidden' ? 'warn' : 'error'}>
          {workloads.code === 'authz.forbidden'
            ? t('common.requiresPermission', { permission: 'workloads.read' })
            : t('errors.generic')}
        </Notice>
      </>
    );
  }

  const visible = tenantId
    ? workloads.data.workloads.filter((workload) =>
        clusters.ok
          ? clusters.data.clusters.some(
              (cluster) => cluster.id === workload.clusterId && cluster.tenantId === tenantId,
            )
          : true,
      )
    : workloads.data.workloads;

  /*
   * Builds still under way, and the ones that failed recently. A build that
   * succeeded is an ordinary VM by now and shows as one. Failing to read builds
   * leaves the inventory as it is rather than refusing the page.
   */
  const now = Date.now();
  const builds = (provisionings.ok ? provisionings.data : []).filter(
    (build) =>
      (!tenantId || build.tenantId === tenantId) &&
      (build.state === 'QUEUED' ||
        build.state === 'RUNNING' ||
        (build.state === 'FAILED' &&
          build.finishedAt !== null &&
          now - new Date(build.finishedAt).getTime() < FAILED_SHOWN_MS)),
  );
  const underway = builds.filter((build) => build.state === 'QUEUED' || build.state === 'RUNNING');

  // A VM being built is in Proxmox from the create step on, and the inventory
  // may already have seen it: list it once, as the build.
  const building = new Set(
    underway
      .filter((build) => build.clusterId && build.vmid !== null)
      .map((build) => `${build.clusterId}/${build.vmid}`),
  );
  const guests = visible.filter(
    (workload) => !building.has(`${workload.clusterId}/${workload.vmid}`),
  );

  return (
    <>
      <PageHeader
        title={t('nav.virtualMachines')}
        description={t('inventory.vmPageDescription')}
        actions={actions}
      />
      <RefreshWhile active={underway.length > 0} seconds={refresh} />
      <WorkloadTable
        workloads={guests}
        builds={builds}
        title={t('nav.virtualMachines')}
        description={t('inventory.workloadsSubtitle')}
      />
    </>
  );
}

'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import type { ClusterSummary, SiteSummary, TenantSummary } from '@/lib/session-types';
import { apiPost, type ApiFailure } from '@/lib/client-api';
import { useApiError } from '@/lib/use-api-error';
import { Button, FormError, TextInput } from '@/components/ui/form';
import { Card, Notice, StatusBadge } from '@/components/ui/primitives';
import { AddCluster } from './add-cluster';
import { ConnectionBadge, HealthBadge } from './primitives';

/**
 * The cluster list.
 *
 * Three columns carry the weight: health, what version it is on, and when
 * Velnox last managed to read it. The third is the one people forget to build —
 * an inventory screen that cannot tell you it is stale is worse than no
 * inventory screen, because it looks exactly the same when discovery has been
 * failing for a week.
 */
export function ClusterAdmin({
  clusters,
  tenants,
  sites,
  canManage,
}: {
  clusters: ClusterSummary[];
  tenants: TenantSummary[];
  sites: SiteSummary[];
  canManage: boolean;
}) {
  const t = useTranslations();
  const format = useFormatter();
  const router = useRouter();
  const describeError = useApiError();

  const [adding, setAdding] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return clusters;
    return clusters.filter(
      (cluster) =>
        cluster.name.toLowerCase().includes(needle) ||
        cluster.endpointHost.includes(needle) ||
        cluster.tenantName.toLowerCase().includes(needle),
    );
  }, [clusters, search]);

  const showTenantColumn = useMemo(
    () => new Set(clusters.map((cluster) => cluster.tenantId)).size > 1,
    [clusters],
  );

  async function discover(cluster: ClusterSummary) {
    setPending(cluster.id);
    setFailure(null);
    const result = await apiPost(`/clusters/${cluster.id}/discover`);
    setPending(null);

    if (!result.ok) {
      setFailure(result.error);
      return;
    }

    /*
     * A discovery run takes seconds, not milliseconds, and nothing streams yet
     * (phase 5). Refreshing immediately would show the same page back. The
     * honest thing is to say it was queued and let the operator refresh — so
     * this only refreshes, and the row's "last read" column is what tells them
     * it worked.
     */
    router.refresh();
  }

  return (
    <div className="space-y-4">
      {failure && <FormError>{describeError(failure)}</FormError>}

      {adding && (
        <AddCluster
          tenants={tenants}
          sites={sites}
          onDone={() => {
            setAdding(false);
            router.refresh();
          }}
          onCancel={() => setAdding(false)}
        />
      )}

      <Card
        title={t('clusters.title')}
        description={t('clusters.subtitle')}
        actions={
          canManage &&
          !adding && <Button onClick={() => setAdding(true)}>{t('clusters.add')}</Button>
        }
        bodyClassName=""
      >
        <div className="border-b border-line px-4 py-2.5">
          <label className="flex items-center gap-2">
            <span className="sr-only">{t('common.search')}</span>
            <TextInput
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('clusters.searchPlaceholder')}
              className="h-8 max-w-xs text-xs"
            />
          </label>
        </div>

        {visible.length === 0 ? (
          <p className="px-4 py-6 text-sm text-ink-muted">{t('clusters.none')}</p>
        ) : (
          <div className="max-h-[60vh] overflow-auto">
            <table className="w-full border-collapse text-sm">
              <thead className="sticky top-0 z-10 bg-surface-2 text-left text-xs text-ink-muted shadow-[0_1px_0_var(--velnox-border)]">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">
                    {t('clusters.name')}
                  </th>
                  {showTenantColumn && (
                    <th scope="col" className="px-3 py-2 font-medium">
                      {t('sites.tenant')}
                    </th>
                  )}
                  <th scope="col" className="px-3 py-2 font-medium">
                    {t('inventory.health')}
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    {t('clusters.version')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    {t('nav.nodes')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    {t('clusters.guests')}
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    {t('clusters.lastRead')}
                  </th>
                  <th scope="col" className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {visible.map((cluster) => (
                  <tr
                    key={cluster.id}
                    className="border-b border-line/70 align-middle hover:bg-surface-2/50"
                  >
                    <td className="px-4 py-2.5">
                      <Link
                        href={`/clusters/${cluster.id}`}
                        className="font-medium text-accent underline-offset-2 hover:underline"
                      >
                        {cluster.name}
                      </Link>
                      <span className="block font-mono text-[11px] text-ink-muted">
                        {cluster.endpointHost}:{cluster.endpointPort}
                      </span>
                    </td>
                    {showTenantColumn && (
                      <td className="px-3 py-2.5 text-ink-muted">{cluster.tenantName}</td>
                    )}
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <HealthBadge health={cluster.health} />
                        {cluster.connectionState !== 'CONNECTED' && (
                          <ConnectionBadge state={cluster.connectionState} />
                        )}
                        {cluster.kind === 'STANDALONE' && (
                          <StatusBadge tone="neutral">{t('clusters.standalone')}</StatusBadge>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs text-ink-muted">
                      {cluster.pveVersions.length > 1 ? (
                        <span className="text-warn">{cluster.pveVersions.join(', ')}</span>
                      ) : (
                        (cluster.pveVersion ?? '—')
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-ink-muted">
                      {cluster.nodeCount}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-ink-muted">
                      {cluster.workloadCount}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-ink-muted">
                      {cluster.lastSeenAt ? (
                        format.relativeTime(new Date(cluster.lastSeenAt))
                      ) : (
                        <span className="text-warn">{t('clusters.neverRead')}</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <Button
                        variant="quiet"
                        className="h-7 px-2 text-xs"
                        pending={pending === cluster.id}
                        onClick={() => void discover(cluster)}
                      >
                        {t('clusters.discoverNow')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {clusters.some((cluster) => cluster.connectionState === 'FAILED') && (
        <Notice tone="error" title={t('clusters.failingTitle')}>
          <p>{t('clusters.failingBody')}</p>
        </Notice>
      )}
    </div>
  );
}

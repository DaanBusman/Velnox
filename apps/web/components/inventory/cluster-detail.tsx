'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import type {
  CephDaemonSummary,
  ClusterSummary,
  DiscoveryRunRow,
  NodeSummary,
  WorkloadSummary,
} from '@/lib/session-types';
import { apiDelete, apiPost, type ApiFailure } from '@/lib/client-api';
import { useApiError } from '@/lib/use-api-error';
import { Button, FormError } from '@/components/ui/form';
import { Card, KeyValue, Notice, StatusBadge } from '@/components/ui/primitives';
import { NodeTable, WorkloadTable } from './tables';
import { Absent, ConnectionBadge, Fingerprint, HealthBadge } from './primitives';

type Tab = 'nodes' | 'guests' | 'ceph' | 'connection' | 'runs';

/**
 * One cluster.
 *
 * Tabs rather than one long page, because the questions are different: "is it
 * healthy" is the nodes tab, "what is running" is the guests tab, and "why is
 * the inventory stale" is the runs tab — and the third is the one that only
 * matters occasionally but matters completely when it does.
 *
 * The Ceph tab is absent for a cluster without Ceph. Not empty: absent. Tiles
 * reading "0 OSDs" on a cluster that has never had Ceph teach an operator to
 * ignore the Ceph section, which is the opposite of what it is for.
 */
export function ClusterDetail({
  cluster,
  nodes,
  workloads,
  cephDaemons,
  runs,
  canManage,
}: {
  cluster: ClusterSummary;
  nodes: NodeSummary[];
  workloads: WorkloadSummary[];
  cephDaemons: CephDaemonSummary[];
  runs: DiscoveryRunRow[];
  canManage: boolean;
}) {
  const t = useTranslations();
  const format = useFormatter();
  const router = useRouter();
  const describeError = useApiError();

  const [tab, setTab] = useState<Tab>('nodes');
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);

  const tabs: { key: Tab; label: string }[] = [
    { key: 'nodes', label: t('nav.nodes') },
    { key: 'guests', label: t('clusters.guests') },
    ...(cluster.cephPresent ? [{ key: 'ceph' as const, label: t('clusters.ceph') }] : []),
    { key: 'connection', label: t('clusters.connection') },
    { key: 'runs', label: t('clusters.runs') },
  ];

  async function run(key: string, action: () => Promise<{ ok: boolean; error?: ApiFailure }>) {
    setPending(key);
    setFailure(null);
    const result = await action();
    setPending(null);
    if (!result.ok) {
      setFailure(result.error ?? { code: 'generic', status: 0 });
      return false;
    }
    router.refresh();
    return true;
  }

  return (
    <div className="space-y-4">
      {failure && <FormError>{describeError(failure)}</FormError>}

      <Card
        title={cluster.name}
        description={`${cluster.endpointHost}:${cluster.endpointPort}`}
        actions={
          <Button
            variant="secondary"
            pending={pending === 'discover'}
            onClick={() => void run('discover', () => apiPost(`/clusters/${cluster.id}/discover`))}
          >
            {t('clusters.discoverNow')}
          </Button>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <HealthBadge health={cluster.health} />
          <ConnectionBadge state={cluster.connectionState} />
          {cluster.kind === 'STANDALONE' && (
            <StatusBadge tone="neutral">{t('clusters.standalone')}</StatusBadge>
          )}
          {cluster.kind === 'CLUSTER' && (
            <StatusBadge
              tone={cluster.quorate === false ? 'error' : cluster.quorate ? 'ok' : 'unknown'}
            >
              {cluster.quorate === false
                ? t('clusters.notQuorate')
                : cluster.quorate
                  ? t('clusters.quorate')
                  : t('inventory.healthUNKNOWN')}
            </StatusBadge>
          )}
          {cluster.pveVersions.length > 1 && (
            <StatusBadge tone="warn">{t('clusters.mixedVersions')}</StatusBadge>
          )}
          {cluster.cephFlags.map((flag) => (
            <StatusBadge key={flag} tone="warn">
              {flag}
            </StatusBadge>
          ))}
        </div>

        {cluster.connectionState === 'FAILED' && (
          <Notice tone="error" title={t('clusters.lastRunFailed')}>
            <p className="font-mono text-xs">{cluster.lastErrorDetail ?? cluster.lastErrorCode}</p>
            <p className="mt-2">{t('clusters.staleWarning')}</p>
          </Notice>
        )}

        <dl className="mt-3">
          <KeyValue label={t('clusters.version')}>
            {cluster.pveVersions.length > 0 ? cluster.pveVersions.join(', ') : <Absent />}
          </KeyValue>
          <KeyValue label={t('sites.tenant')}>{cluster.tenantName}</KeyValue>
          <KeyValue label={t('nav.sites')}>{cluster.siteName ?? t('clusters.noSite')}</KeyValue>
          <KeyValue label={t('clusters.lastRead')}>
            {cluster.lastSeenAt ? (
              format.dateTime(new Date(cluster.lastSeenAt), 'medium')
            ) : (
              <span className="text-warn">{t('clusters.neverRead')}</span>
            )}
          </KeyValue>
          <KeyValue label={t('clusters.discoveryInterval')}>
            {cluster.discoveryIntervalMinutes === 0
              ? t('clusters.discoveryOff')
              : t('clusters.everyMinutes', { minutes: cluster.discoveryIntervalMinutes })}
          </KeyValue>
        </dl>
      </Card>

      <nav
        className="flex flex-wrap gap-1 border-b border-line"
        aria-label={t('clusters.sections')}
      >
        {tabs.map((entry) => (
          <button
            key={entry.key}
            type="button"
            aria-current={tab === entry.key ? 'true' : undefined}
            onClick={() => setTab(entry.key)}
            className={
              tab === entry.key
                ? 'rounded-t border-b-2 border-accent px-3 py-2 text-sm font-medium text-accent'
                : 'rounded-t border-b-2 border-transparent px-3 py-2 text-sm text-ink-muted hover:text-ink'
            }
          >
            {entry.label}
          </button>
        ))}
      </nav>

      {tab === 'nodes' && <NodeTable nodes={nodes} showCluster={false} />}

      {tab === 'guests' && (
        <WorkloadTable
          workloads={workloads}
          title={t('clusters.guests')}
          description={t('inventory.workloadsSubtitle')}
          showCluster={false}
        />
      )}

      {tab === 'ceph' && <CephPanel cluster={cluster} daemons={cephDaemons} />}

      {tab === 'connection' && (
        <Card title={t('clusters.connection')} description={t('clusters.connectionSubtitle')}>
          <dl>
            <KeyValue label={t('clusters.endpoint')}>
              <span className="font-mono text-xs">
                {cluster.endpointHost}:{cluster.endpointPort}
              </span>
            </KeyValue>
            <KeyValue label={t('clusters.authKind')}>
              {cluster.authKind === 'API_TOKEN'
                ? t('clusters.authToken')
                : t('clusters.authPassword')}
            </KeyValue>
            <KeyValue label={t('clusters.principal')}>
              <span className="font-mono text-xs">{cluster.authPrincipal ?? <Absent />}</span>
            </KeyValue>
          </dl>

          <div className="mt-3">
            <p className="mb-1 text-xs font-medium text-ink-muted">
              {t('clusters.pinnedFingerprint')}
            </p>
            {cluster.tlsFingerprint ? <Fingerprint value={cluster.tlsFingerprint} /> : <Absent />}
            <p className="mt-2 text-xs text-ink-muted">{t('clusters.fingerprintExplainer')}</p>
          </div>

          {canManage && (
            <div className="mt-4 border-t border-line pt-4">
              {confirmingRemoval ? (
                <Notice tone="warn" title={t('clusters.removeTitle')}>
                  <p>{t('clusters.removeBody')}</p>
                  <div className="mt-2 flex gap-2">
                    <Button
                      variant="secondary"
                      className="h-8 text-xs"
                      pending={pending === 'remove'}
                      onClick={() =>
                        void run('remove', () => apiDelete(`/clusters/${cluster.id}`)).then(
                          (ok) => {
                            if (ok) router.push('/clusters');
                          },
                        )
                      }
                    >
                      {t('clusters.removeConfirm')}
                    </Button>
                    <Button
                      variant="quiet"
                      className="h-8 text-xs"
                      onClick={() => setConfirmingRemoval(false)}
                    >
                      {t('common.cancel')}
                    </Button>
                  </div>
                </Notice>
              ) : (
                <Button
                  variant="quiet"
                  className="h-8 px-2 text-xs"
                  onClick={() => setConfirmingRemoval(true)}
                >
                  {t('clusters.remove')}
                </Button>
              )}
            </div>
          )}
        </Card>
      )}

      {tab === 'runs' && <RunsPanel runs={runs} />}
    </div>
  );
}

function CephPanel({
  cluster,
  daemons,
}: {
  cluster: ClusterSummary;
  daemons: CephDaemonSummary[];
}) {
  const t = useTranslations();

  const byKind = daemons.reduce<Record<string, CephDaemonSummary[]>>((groups, daemon) => {
    (groups[daemon.kind] ??= []).push(daemon);
    return groups;
  }, {});

  return (
    <div className="space-y-4">
      <Card title={t('clusters.ceph')} description={t('clusters.cephSubtitle')}>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge
            tone={
              cluster.cephHealth === 'HEALTH_OK'
                ? 'ok'
                : cluster.cephHealth === 'HEALTH_ERR'
                  ? 'error'
                  : 'warn'
            }
          >
            {cluster.cephHealth ?? t('inventory.healthUNKNOWN')}
          </StatusBadge>
          {cluster.cephVersionsHomogeneous === false && (
            <StatusBadge tone="warn">{t('clusters.cephMixedVersions')}</StatusBadge>
          )}
          {cluster.cephFlags.map((flag) => (
            <StatusBadge key={flag} tone="warn">
              {flag}
            </StatusBadge>
          ))}
        </div>

        {cluster.cephFlags.includes('noout') && (
          <Notice tone="warn" title={t('clusters.nooutTitle')}>
            {t('clusters.nooutBody')}
          </Notice>
        )}
      </Card>

      <Card title={t('clusters.cephDaemons')} bodyClassName="">
        {daemons.length === 0 ? (
          <p className="px-4 py-6 text-sm text-ink-muted">{t('clusters.noCephDaemons')}</p>
        ) : (
          <div className="max-h-[50vh] overflow-auto">
            <table className="w-full border-collapse text-sm">
              <thead className="sticky top-0 z-10 bg-surface-2 text-left text-xs text-ink-muted shadow-[0_1px_0_var(--velnox-border)]">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">
                    {t('clusters.daemon')}
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    {t('inventory.type')}
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    {t('inventory.node')}
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    {t('clusters.version')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(byKind).map(([kind, entries]) =>
                  entries.map((daemon) => (
                    <tr key={daemon.id} className="border-b border-line/70 hover:bg-surface-2/50">
                      <td className="px-4 py-2 font-mono text-xs text-ink">{daemon.daemonId}</td>
                      <td className="px-3 py-2 text-ink-muted">{kind}</td>
                      <td className="px-3 py-2 text-ink-muted">{daemon.host ?? <Absent />}</td>
                      <td className="px-3 py-2 font-mono text-xs text-ink-muted">
                        {daemon.version ?? <Absent />}
                      </td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function RunsPanel({ runs }: { runs: DiscoveryRunRow[] }) {
  const t = useTranslations();
  const format = useFormatter();

  return (
    <Card title={t('clusters.runs')} description={t('clusters.runsSubtitle')} bodyClassName="">
      {runs.length === 0 ? (
        <p className="px-4 py-6 text-sm text-ink-muted">{t('clusters.noRuns')}</p>
      ) : (
        <ul className="divide-y divide-line">
          {runs.map((entry) => (
            <li key={entry.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge
                  tone={
                    entry.state === 'SUCCEEDED'
                      ? 'ok'
                      : entry.state === 'PARTIAL'
                        ? 'warn'
                        : entry.state === 'FAILED'
                          ? 'error'
                          : 'neutral'
                  }
                >
                  {t(`clusters.run${entry.state}`)}
                </StatusBadge>
                <span className="text-xs text-ink-muted">
                  {format.dateTime(new Date(entry.startedAt), 'medium')}
                </span>
                {entry.durationMs !== null && (
                  <span className="text-xs text-ink-muted">
                    {t('clusters.runDuration', {
                      seconds: Math.round(entry.durationMs / 100) / 10,
                    })}
                  </span>
                )}
                {entry.nodesSeen !== null && (
                  <span className="text-xs text-ink-muted">
                    {t('clusters.runCounts', {
                      nodes: entry.nodesSeen,
                      workloads: entry.workloadsSeen ?? 0,
                    })}
                  </span>
                )}
              </div>

              {entry.errorDetail && (
                <p className="mt-1 font-mono text-[11px] text-error">{entry.errorDetail}</p>
              )}

              {entry.problems.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {entry.problems.map((problem, index) => (
                    <li key={index} className="font-mono text-[11px] text-warn">
                      {problem}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

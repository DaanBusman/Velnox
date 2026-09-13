'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import type { NodeDetail as NodeDetailData } from '@/lib/session-types';
import { Card, KeyValue, Notice, StatusBadge } from '@/components/ui/primitives';
import { InterfaceTable, StorageTable, WorkloadTable } from './tables';
import { Absent, HealthBadge, NodeStateBadge, UsageBar, formatUptime } from './primitives';

type Tab = 'overview' | 'storage' | 'network' | 'guests' | 'repositories';

/**
 * One node.
 *
 * The overview is what somebody looks at during an incident, so it carries the
 * four things that answer "is this machine in trouble" — state, memory, root
 * disk, and whether the last discovery run could read it at all — above
 * everything else.
 */
export function NodeDetailView({ node }: { node: NodeDetailData }) {
  const t = useTranslations();
  const format = useFormatter();
  const [tab, setTab] = useState<Tab>('overview');

  const tabs: { key: Tab; label: string }[] = [
    { key: 'overview', label: t('inventory.overview') },
    { key: 'storage', label: t('nav.storage') },
    { key: 'network', label: t('nav.networks') },
    { key: 'guests', label: t('clusters.guests') },
    { key: 'repositories', label: t('inventory.repositories') },
  ];

  return (
    <div className="space-y-4">
      <Card
        title={node.name}
        description={
          <Link
            href={`/clusters/${node.clusterId}`}
            className="text-accent underline-offset-2 hover:underline"
          >
            {node.clusterName}
          </Link>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <NodeStateBadge state={node.state} />
          <HealthBadge health={node.health} />
          {node.subscriptionStatus && node.subscriptionStatus !== 'active' && (
            <StatusBadge tone="warn">
              {t('inventory.subscription', { status: node.subscriptionStatus })}
            </StatusBadge>
          )}
          {node.updatesAvailable !== null && node.updatesAvailable > 0 && (
            <StatusBadge tone="warn">
              {t('inventory.updatesPending', { count: node.updatesAvailable })}
            </StatusBadge>
          )}
        </div>

        {node.problems.length > 0 && (
          <Notice tone="warn" title={t('inventory.problemsTitle')}>
            <ul className="space-y-0.5">
              {node.problems.map((problem, index) => (
                <li key={index} className="font-mono text-[11px]">
                  {problem}
                </li>
              ))}
            </ul>
          </Notice>
        )}
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

      {tab === 'overview' && (
        <Card title={t('inventory.overview')}>
          <dl>
            <KeyValue label={t('inventory.memory')}>
              <UsageBar used={node.memoryUsedBytes} total={node.memoryTotalBytes} />
            </KeyValue>
            <KeyValue label={t('inventory.rootDisk')}>
              <UsageBar used={node.rootfsUsedBytes} total={node.rootfsTotalBytes} />
            </KeyValue>
            <KeyValue label={t('inventory.cpu')}>
              {node.cpuCount === null ? (
                <Absent />
              ) : (
                t('inventory.cpuDetail', { count: node.cpuCount, model: node.cpuModel ?? '—' })
              )}
            </KeyValue>
            <KeyValue label={t('clusters.version')}>
              <span className="font-mono text-xs">{node.pveVersion ?? <Absent />}</span>
            </KeyValue>
            <KeyValue label={t('inventory.kernel')}>
              <span className="font-mono text-xs">{node.kernelVersion ?? <Absent />}</span>
            </KeyValue>
            <KeyValue label={t('inventory.subscriptionLabel')}>
              {node.subscriptionStatus ?? <Absent />}
              {node.subscriptionLevel ? ` (${node.subscriptionLevel})` : ''}
            </KeyValue>
            <KeyValue label={t('inventory.uptime')}>{formatUptime(node.uptimeSeconds)}</KeyValue>
            <KeyValue label={t('inventory.address')}>
              <span className="font-mono text-xs">{node.address ?? <Absent />}</span>
            </KeyValue>
            <KeyValue label={t('clusters.lastRead')}>
              {node.lastSeenAt ? format.dateTime(new Date(node.lastSeenAt), 'medium') : <Absent />}
            </KeyValue>
          </dl>
        </Card>
      )}

      {tab === 'storage' && <StorageTable storages={node.storages} showNode={false} />}
      {tab === 'network' && <InterfaceTable interfaces={node.interfaces} showNode={false} />}

      {tab === 'guests' && (
        <WorkloadTable
          workloads={node.workloads}
          title={t('clusters.guests')}
          description={t('inventory.workloadsSubtitle')}
          showCluster={false}
        />
      )}

      {tab === 'repositories' && (
        <Card
          title={t('inventory.repositories')}
          description={t('inventory.repositoriesSubtitle')}
          bodyClassName=""
        >
          {node.repositories.length === 0 ? (
            <p className="px-4 py-6 text-sm text-ink-muted">{t('inventory.noRepositories')}</p>
          ) : (
            <ul className="divide-y divide-line">
              {node.repositories.map((repository, index) => (
                <li key={index} className="px-4 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge tone={repository.enabled ? 'ok' : 'neutral'}>
                      {repository.enabled ? t('inventory.enabled') : t('inventory.disabled')}
                    </StatusBadge>
                    <span className="font-mono text-xs text-ink">
                      {repository.uris.join(' ')} {repository.suites.join(' ')}{' '}
                      {repository.components.join(' ')}
                    </span>
                  </div>
                  <span className="mt-0.5 block font-mono text-[11px] text-ink-muted">
                    {repository.file}
                    {repository.comment ? ` — ${repository.comment}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}

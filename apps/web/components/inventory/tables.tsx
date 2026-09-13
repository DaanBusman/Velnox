'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import type {
  AlertRow,
  InterfaceRow,
  NodeSummary,
  StorageRow,
  WorkloadSummary,
} from '@/lib/session-types';
import { TextInput } from '@/components/ui/form';
import { Card, StatusBadge, type StatusTone } from '@/components/ui/primitives';
import {
  Absent,
  HealthBadge,
  NodeStateBadge,
  UsageBar,
  formatBytes,
  formatUptime,
} from './primitives';

/**
 * The inventory tables.
 *
 * One file because they are the same object four times over — a scrolling table
 * under a sticky header with a search box — and four near-identical components
 * in four files is four places for the same header to drift.
 */

function Search({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  const t = useTranslations();
  return (
    <div className="border-b border-line px-4 py-2.5">
      <label className="flex items-center gap-2">
        <span className="sr-only">{t('common.search')}</span>
        <TextInput
          type="search"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className="h-8 max-w-xs text-xs"
        />
      </label>
    </div>
  );
}

const THEAD =
  'sticky top-0 z-10 bg-surface-2 text-left text-xs text-ink-muted shadow-[0_1px_0_var(--velnox-border)]';
const ROW = 'border-b border-line/70 align-middle hover:bg-surface-2/50';

export function NodeTable({
  nodes,
  showCluster = true,
}: {
  nodes: NodeSummary[];
  showCluster?: boolean;
}) {
  const t = useTranslations();
  const format = useFormatter();
  const [search, setSearch] = useState('');

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return nodes;
    return nodes.filter(
      (node) =>
        node.name.toLowerCase().includes(needle) ||
        node.clusterName.toLowerCase().includes(needle) ||
        (node.pveVersion ?? '').includes(needle),
    );
  }, [nodes, search]);

  return (
    <Card title={t('nav.nodes')} description={t('inventory.nodesSubtitle')} bodyClassName="">
      <Search value={search} onChange={setSearch} placeholder={t('inventory.nodeSearch')} />

      {visible.length === 0 ? (
        <p className="px-4 py-6 text-sm text-ink-muted">{t('inventory.noNodes')}</p>
      ) : (
        <div className="max-h-[65vh] overflow-auto">
          <table className="w-full border-collapse text-sm">
            <thead className={THEAD}>
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">
                  {t('inventory.node')}
                </th>
                {showCluster && (
                  <th scope="col" className="px-3 py-2 font-medium">
                    {t('inventory.cluster')}
                  </th>
                )}
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('inventory.state')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('clusters.version')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('inventory.memory')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('inventory.rootDisk')}
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  {t('inventory.updates')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('inventory.uptime')}
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((node) => (
                <tr key={node.id} className={ROW}>
                  <td className="px-4 py-2.5">
                    <Link
                      href={`/nodes/${node.id}`}
                      className="font-medium text-accent underline-offset-2 hover:underline"
                    >
                      {node.name}
                    </Link>
                    {node.address && (
                      <span className="block font-mono text-[11px] text-ink-muted">
                        {node.address}
                      </span>
                    )}
                  </td>
                  {showCluster && (
                    <td className="px-3 py-2.5 text-ink-muted">
                      <Link
                        href={`/clusters/${node.clusterId}`}
                        className="underline-offset-2 hover:underline"
                      >
                        {node.clusterName}
                      </Link>
                    </td>
                  )}
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <NodeStateBadge state={node.state} />
                      {node.health !== 'OK' && node.state === 'ONLINE' && (
                        <HealthBadge health={node.health} />
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 font-mono text-xs text-ink-muted">
                    {node.pveVersion ?? <Absent />}
                  </td>
                  <td className="px-3 py-2.5">
                    <UsageBar used={node.memoryUsedBytes} total={node.memoryTotalBytes} />
                  </td>
                  <td className="px-3 py-2.5">
                    <UsageBar used={node.rootfsUsedBytes} total={node.rootfsTotalBytes} />
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-ink-muted">
                    {node.updatesAvailable === null ? (
                      <Absent />
                    ) : node.updatesAvailable > 0 ? (
                      <span className="text-warn">{node.updatesAvailable}</span>
                    ) : (
                      node.updatesAvailable
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-ink-muted">
                    {node.state === 'ONLINE' ? (
                      formatUptime(node.uptimeSeconds)
                    ) : node.lastSeenAt ? (
                      format.relativeTime(new Date(node.lastSeenAt))
                    ) : (
                      <Absent />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

const WORKLOAD_TONE: Record<WorkloadSummary['state'], StatusTone> = {
  RUNNING: 'ok',
  STOPPED: 'neutral',
  PAUSED: 'warn',
  UNKNOWN: 'unknown',
};

export function WorkloadTable({
  workloads,
  title,
  description,
  showCluster = true,
}: {
  workloads: WorkloadSummary[];
  title: string;
  description: string;
  showCluster?: boolean;
}) {
  const t = useTranslations();
  const [search, setSearch] = useState('');

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return workloads;
    return workloads.filter(
      (workload) =>
        (workload.name ?? '').toLowerCase().includes(needle) ||
        String(workload.vmid).includes(needle) ||
        (workload.nodeName ?? '').toLowerCase().includes(needle) ||
        workload.tags.some((tag) => tag.toLowerCase().includes(needle)),
    );
  }, [workloads, search]);

  return (
    <Card title={title} description={description} bodyClassName="">
      <Search value={search} onChange={setSearch} placeholder={t('inventory.workloadSearch')} />

      {visible.length === 0 ? (
        <p className="px-4 py-6 text-sm text-ink-muted">{t('inventory.noWorkloads')}</p>
      ) : (
        <div className="max-h-[65vh] overflow-auto">
          <table className="w-full border-collapse text-sm">
            <thead className={THEAD}>
              <tr>
                <th scope="col" className="px-4 py-2 text-right font-medium">
                  {t('inventory.vmid')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('inventory.name')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('inventory.state')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('inventory.node')}
                </th>
                {showCluster && (
                  <th scope="col" className="px-3 py-2 font-medium">
                    {t('inventory.cluster')}
                  </th>
                )}
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  {t('inventory.cpu')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('inventory.memory')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('inventory.uptime')}
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((workload) => (
                <tr key={workload.id} className={ROW}>
                  <td className="px-4 py-2.5 text-right font-mono tabular-nums text-ink-muted">
                    {workload.vmid}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="font-medium text-ink">{workload.name ?? <Absent />}</span>
                    {workload.tags.length > 0 && (
                      <span className="mt-0.5 flex flex-wrap gap-1">
                        {workload.tags.map((tag) => (
                          <span
                            key={tag}
                            className="rounded border border-line bg-surface-2 px-1 text-[10px] text-ink-muted"
                          >
                            {tag}
                          </span>
                        ))}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <StatusBadge tone={WORKLOAD_TONE[workload.state]}>
                        {t(`inventory.workload${workload.state}`)}
                      </StatusBadge>
                      {workload.template && (
                        <StatusBadge tone="neutral">{t('inventory.template')}</StatusBadge>
                      )}
                      {/* A state Velnox does not recognise shows what Proxmox
                          actually said, rather than disappearing into UNKNOWN. */}
                      {workload.state === 'UNKNOWN' && workload.rawStatus && (
                        <span className="font-mono text-[10px] text-ink-muted">
                          {workload.rawStatus}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-ink-muted">
                    {workload.nodeId ? (
                      <Link
                        href={`/nodes/${workload.nodeId}`}
                        className="underline-offset-2 hover:underline"
                      >
                        {workload.nodeName}
                      </Link>
                    ) : (
                      <Absent />
                    )}
                  </td>
                  {showCluster && (
                    <td className="px-3 py-2.5 text-ink-muted">{workload.clusterName}</td>
                  )}
                  <td className="px-3 py-2.5 text-right tabular-nums text-ink-muted">
                    {workload.cpuCount ?? <Absent />}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-ink-muted">
                    {formatBytes(workload.memoryMaxBytes)}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-ink-muted">
                    {workload.state === 'RUNNING' ? (
                      formatUptime(workload.uptimeSeconds)
                    ) : (
                      <Absent />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function StorageTable({
  storages,
  showNode = true,
}: {
  storages: StorageRow[];
  showNode?: boolean;
}) {
  const t = useTranslations();
  const [search, setSearch] = useState('');

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return storages;
    return storages.filter(
      (storage) =>
        storage.name.toLowerCase().includes(needle) ||
        storage.type.toLowerCase().includes(needle) ||
        (storage.nodeName ?? '').toLowerCase().includes(needle),
    );
  }, [storages, search]);

  return (
    <Card title={t('nav.storage')} description={t('inventory.storageSubtitle')} bodyClassName="">
      <Search value={search} onChange={setSearch} placeholder={t('inventory.storageSearch')} />

      {visible.length === 0 ? (
        <p className="px-4 py-6 text-sm text-ink-muted">{t('inventory.noStorage')}</p>
      ) : (
        <div className="max-h-[65vh] overflow-auto">
          <table className="w-full border-collapse text-sm">
            <thead className={THEAD}>
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">
                  {t('inventory.name')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('inventory.type')}
                </th>
                {showNode && (
                  <th scope="col" className="px-3 py-2 font-medium">
                    {t('inventory.node')}
                  </th>
                )}
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('inventory.state')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('inventory.usage')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('inventory.content')}
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((storage, index) => (
                <tr
                  key={storage.id ?? `${storage.nodeId}-${storage.name}-${index}`}
                  className={ROW}
                >
                  <td className="px-4 py-2.5 font-medium text-ink">{storage.name}</td>
                  <td className="px-3 py-2.5 font-mono text-xs text-ink-muted">{storage.type}</td>
                  {showNode && (
                    <td className="px-3 py-2.5 text-ink-muted">
                      {storage.nodeId ? (
                        <Link
                          href={`/nodes/${storage.nodeId}`}
                          className="underline-offset-2 hover:underline"
                        >
                          {storage.nodeName}
                        </Link>
                      ) : (
                        <Absent />
                      )}
                    </td>
                  )}
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <StatusBadge
                        tone={storage.active ? 'ok' : storage.enabled ? 'warn' : 'neutral'}
                      >
                        {storage.active
                          ? t('inventory.storageActive')
                          : storage.enabled
                            ? t('inventory.storageInactive')
                            : t('inventory.storageDisabled')}
                      </StatusBadge>
                      {storage.shared && (
                        <StatusBadge tone="neutral">{t('inventory.shared')}</StatusBadge>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <UsageBar used={storage.usedBytes} total={storage.totalBytes} />
                  </td>
                  <td className="px-3 py-2.5 text-xs text-ink-muted">
                    {storage.content.join(', ') || <Absent />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function InterfaceTable({
  interfaces,
  showNode = true,
}: {
  interfaces: InterfaceRow[];
  showNode?: boolean;
}) {
  const t = useTranslations();
  const [search, setSearch] = useState('');

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return interfaces;
    return interfaces.filter(
      (entry) =>
        entry.name.toLowerCase().includes(needle) ||
        (entry.cidr ?? '').includes(needle) ||
        (entry.nodeName ?? '').toLowerCase().includes(needle),
    );
  }, [interfaces, search]);

  return (
    <Card title={t('nav.networks')} description={t('inventory.networksSubtitle')} bodyClassName="">
      <Search value={search} onChange={setSearch} placeholder={t('inventory.networkSearch')} />

      {visible.length === 0 ? (
        <p className="px-4 py-6 text-sm text-ink-muted">{t('inventory.noNetworks')}</p>
      ) : (
        <div className="max-h-[65vh] overflow-auto">
          <table className="w-full border-collapse text-sm">
            <thead className={THEAD}>
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">
                  {t('inventory.interface')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('inventory.type')}
                </th>
                {showNode && (
                  <th scope="col" className="px-3 py-2 font-medium">
                    {t('inventory.node')}
                  </th>
                )}
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('inventory.address')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('inventory.gateway')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('inventory.ports')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('inventory.state')}
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((entry, index) => (
                <tr key={entry.id ?? `${entry.nodeId}-${entry.name}-${index}`} className={ROW}>
                  <td className="px-4 py-2.5 font-medium text-ink">{entry.name}</td>
                  <td className="px-3 py-2.5 font-mono text-xs text-ink-muted">{entry.type}</td>
                  {showNode && (
                    <td className="px-3 py-2.5 text-ink-muted">
                      {entry.nodeId ? (
                        <Link
                          href={`/nodes/${entry.nodeId}`}
                          className="underline-offset-2 hover:underline"
                        >
                          {entry.nodeName}
                        </Link>
                      ) : (
                        <Absent />
                      )}
                    </td>
                  )}
                  <td className="px-3 py-2.5 font-mono text-xs text-ink-muted">
                    {entry.cidr ?? <Absent />}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-xs text-ink-muted">
                    {entry.gateway ?? <Absent />}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-xs text-ink-muted">
                    {[...entry.bridgePorts, ...entry.slaves].join(', ') || <Absent />}
                  </td>
                  <td className="px-3 py-2.5">
                    <StatusBadge tone={entry.active ? 'ok' : 'neutral'}>
                      {entry.active ? t('inventory.up') : t('inventory.down')}
                    </StatusBadge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function AlertTable({ alerts }: { alerts: AlertRow[] }) {
  const t = useTranslations();
  const format = useFormatter();

  if (alerts.length === 0) {
    return (
      <Card title={t('nav.alerts')} description={t('alerts.subtitle')}>
        <p className="text-sm text-ink-muted">{t('alerts.none')}</p>
      </Card>
    );
  }

  return (
    <Card title={t('nav.alerts')} description={t('alerts.subtitle')} bodyClassName="">
      <div className="max-h-[65vh] overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead className={THEAD}>
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">
                {t('alerts.severity')}
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                {t('alerts.what')}
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                {t('inventory.cluster')}
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                {t('sites.tenant')}
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                {t('alerts.since')}
              </th>
            </tr>
          </thead>
          <tbody>
            {alerts.map((alert, index) => (
              <tr
                key={`${alert.clusterId}-${alert.code}-${alert.subject ?? index}`}
                className={ROW}
              >
                <td className="px-4 py-2.5">
                  <StatusBadge tone={alert.severity === 'CRITICAL' ? 'error' : 'warn'}>
                    {t(`alerts.severity${alert.severity}`)}
                  </StatusBadge>
                </td>
                <td className="px-3 py-2.5 text-ink">
                  {/* The API sends a code and its parameters, never a sentence.
                      Dots become underscores because next-intl reads a dot as a
                      level of nesting, and `ceph.flag_set` is one key, not two.
                      An unknown code falls back to the code itself rather than to
                      a blank cell — a new alert must never be invisible. */}
                  {t.has(`alerts.code.${alert.code.replace(/\./g, '_')}`)
                    ? t(
                        `alerts.code.${alert.code.replace(/\./g, '_')}`,
                        alert.params as Record<string, never>,
                      )
                    : alert.code}
                </td>
                <td className="px-3 py-2.5 text-ink-muted">
                  <Link
                    href={`/clusters/${alert.clusterId}`}
                    className="underline-offset-2 hover:underline"
                  >
                    {alert.clusterName}
                  </Link>
                </td>
                <td className="px-3 py-2.5 text-ink-muted">{alert.tenantName}</td>
                <td className="px-3 py-2.5 text-xs text-ink-muted">
                  {alert.since ? format.relativeTime(new Date(alert.since)) : <Absent />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

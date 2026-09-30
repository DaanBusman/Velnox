'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { LibraryItemSummary } from '@velnox/shared';
import { apiGet, apiPost, type ApiFailure } from '@/lib/client-api';
import { useApiError } from '@/lib/use-api-error';
import type { ClusterSummary, StorageRow } from '@/lib/session-types';
import { Button, Field, FormError } from '@/components/ui/form';
import { Card } from '@/components/ui/primitives';
import { FriendlyName } from './friendly-name';

interface Target {
  key: string;
  node: string;
  storage: string;
  shared: boolean;
  label: string;
}

/**
 * Where to copy a library file.
 *
 * Only storage that takes this kind of file and is active is offered, and
 * shared storage is offered once — pushing an ISO to an NFS share through
 * `pve1` and again through `pve2` would be the same file twice. The worker
 * checks all of it again on the node before sending a byte; this is only so the
 * choice that is offered is a choice that can work.
 */
export function PushDialog({
  item,
  onClose,
  onQueued,
}: {
  item: LibraryItemSummary;
  onClose: () => void;
  onQueued: (jobId: string) => void;
}) {
  const t = useTranslations();
  const describeError = useApiError();
  const [clusters, setClusters] = useState<ClusterSummary[] | null>(null);
  const [clusterId, setClusterId] = useState('');
  const [storages, setStorages] = useState<StorageRow[] | null>(null);
  const [target, setTarget] = useState('');
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [pending, setPending] = useState(false);

  const content = item.kind === 'ISO' ? 'iso' : 'import';

  useEffect(() => {
    void apiGet<{ clusters: ClusterSummary[] }>('/clusters').then((result) => {
      if (result.ok)
        setClusters(
          result.data.clusters.filter((cluster) => cluster.connectionState === 'CONNECTED'),
        );
      else setFailure(result.error);
    });
  }, []);

  useEffect(() => {
    setStorages(null);
    setTarget('');
    if (!clusterId) return;
    void apiGet<{ storages: StorageRow[] }>(
      `/storage?clusterId=${encodeURIComponent(clusterId)}`,
    ).then((result) => {
      if (result.ok) setStorages(result.data.storages);
      else setFailure(result.error);
    });
  }, [clusterId]);

  const targets = useMemo<Target[]>(() => {
    const seen = new Set<string>();
    const list: Target[] = [];
    for (const row of storages ?? []) {
      if (!row.active || !row.enabled || !row.content.includes(content) || !row.nodeName) continue;
      const key = row.shared ? row.name : `${row.nodeName}/${row.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({
        key,
        node: row.nodeName,
        storage: row.name,
        shared: row.shared,
        label: row.shared
          ? t('library.pushShared', { storage: row.name })
          : `${row.nodeName} · ${row.name}`,
      });
    }
    return list.sort((a, b) => a.label.localeCompare(b.label));
  }, [storages, content, t]);

  async function push() {
    const chosen = targets.find((entry) => entry.key === target);
    if (!chosen) return;
    setPending(true);
    setFailure(null);
    const result = await apiPost<{ id: string }>(`/library/${item.id}/push`, {
      clusterId,
      node: chosen.node,
      storage: chosen.storage,
    });
    setPending(false);
    if (!result.ok) return setFailure(result.error);
    onQueued(result.data.id);
  }

  const select =
    'block h-9 w-full rounded border border-line bg-surface-2 px-2.5 text-sm text-ink focus:border-accent focus:outline-none';

  return (
    <Card title={t('library.pushTitle')} description={<FriendlyName item={item} />}>
      <div className="space-y-3">
        {failure && <FormError>{describeError(failure)}</FormError>}
        <Field label={t('library.pushCluster')}>
          {(props) => (
            <select
              {...props}
              className={select}
              value={clusterId}
              onChange={(event) => setClusterId(event.target.value)}
            >
              <option value="">
                {clusters === null ? t('common.loading') : t('library.pushChooseCluster')}
              </option>
              {(clusters ?? []).map((cluster) => (
                <option key={cluster.id} value={cluster.id}>
                  {cluster.name} ({cluster.tenantName})
                </option>
              ))}
            </select>
          )}
        </Field>
        {clusterId && (
          <Field
            label={t('library.pushStorage')}
            hint={
              storages !== null && targets.length === 0
                ? t('library.pushNoStorage', { content })
                : undefined
            }
          >
            {(props) => (
              <select
                {...props}
                className={select}
                value={target}
                onChange={(event) => setTarget(event.target.value)}
              >
                <option value="">
                  {storages === null ? t('common.loading') : t('library.pushChooseStorage')}
                </option>
                {targets.map((entry) => (
                  <option key={entry.key} value={entry.key}>
                    {entry.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        <p className="text-xs text-ink-muted">{t('library.pushExplain')}</p>
        <div className="flex gap-2">
          <Button onClick={() => void push()} pending={pending} disabled={!target}>
            {t('library.push')}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    </Card>
  );
}

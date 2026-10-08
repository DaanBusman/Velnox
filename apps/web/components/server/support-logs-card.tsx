'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { apiPut, type ApiFailure } from '@/lib/client-api';
import { useApiError } from '@/lib/use-api-error';
import { Card } from '@/components/ui/primitives';
import { FormError } from '@/components/ui/form';
import { useApiResource } from './use-api-resource';

const RETENTION_CHOICES = [1, 3, 7, 14, 30];

/**
 * Support logs, beside the audit log (Phase 5C): an export of what Velnox did
 * for the tenants in view and of their nodes' Proxmox tasks, in the period
 * chosen above. Hidden from anyone without `support.read`; the retention can be
 * changed by whoever holds `support.manage`.
 */
export function SupportLogsCard({ filters }: { filters: URLSearchParams }) {
  const t = useTranslations();
  const describeError = useApiError();
  const settings = useApiResource<{ retentionDays: number; maxDays: number }>('/support/settings');
  const me = useApiResource<{ user: { permissions: string[] } }>('/auth/me');
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [days, setDays] = useState<number | null>(null);

  if (settings.state !== 'ready') return null;
  const canManage = me.data?.user.permissions.includes('support.manage') ?? false;
  const current = days ?? settings.data.retentionDays;

  const params = new URLSearchParams();
  for (const key of ['tenantId', 'from', 'to']) {
    const value = filters.get(key);
    if (value) params.set(key, value);
  }
  const href = `/api/v1/support/export${params.size ? `?${params.toString()}` : ''}`;

  async function save(next: number) {
    setSaving(true);
    setFailure(null);
    const result = await apiPut<{ retentionDays: number }>('/support/settings', {
      retentionDays: next,
    });
    setSaving(false);
    if (!result.ok) return setFailure(result.error);
    setDays(result.data.retentionDays);
  }

  return (
    <Card title={t('support.title')} description={t('support.description')}>
      <div className="space-y-3 text-sm">
        {failure && <FormError>{describeError(failure)}</FormError>}
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={href}
            download
            className="rounded border border-line bg-surface px-2.5 py-1 text-xs text-ink shadow-card hover:border-line-strong"
          >
            {t('support.export')}
          </a>
          <span className="text-xs text-ink-muted">{t('support.exportHint')}</span>
        </div>
        {canManage ? (
          <label className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
            {t('support.retention')}
            <select
              value={current}
              disabled={saving}
              onChange={(event) => void save(Number(event.target.value))}
              className="h-8 rounded border border-line bg-surface px-2 text-xs text-ink"
            >
              {RETENTION_CHOICES.map((choice) => (
                <option key={choice} value={choice}>
                  {t('support.days', { days: choice })}
                </option>
              ))}
            </select>
            <span>{t('support.retentionHint', { max: settings.data.maxDays })}</span>
          </label>
        ) : (
          <p className="text-xs text-ink-muted">
            {t('support.retentionReadOnly', { days: current })}
          </p>
        )}
      </div>
    </Card>
  );
}

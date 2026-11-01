'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { JobsVisibility } from '@velnox/shared';
import { apiPut, type ApiFailure } from '@/lib/client-api';
import { useApiError } from '@/lib/use-api-error';
import { Card, Notice } from '@/components/ui/primitives';
import { Button, Field, FormError, TextInput } from '@/components/ui/form';
import { useApiResource } from '@/components/server/use-api-resource';

/**
 * Older jobs out of sight (0.7.16).
 *
 * Whoever holds `system.manage` — the MSP Super Administrator — sets after how
 * many days a finished job is hidden from everyone without `jobs.history`.
 * Whoever is affected is told, so an empty list is never a mystery. The API
 * does the hiding; this only says so.
 */
export function JobsVisibilityPanel({ canManage }: { canManage: boolean }) {
  const t = useTranslations();
  const router = useRouter();
  const describeError = useApiError();
  const settings = useApiResource<JobsVisibility>('/jobs/visibility');
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [saved, setSaved] = useState<JobsVisibility | null>(null);

  if (settings.state !== 'ready') return null;
  const current = saved ?? settings.data;

  if (!canManage) {
    if (current.seesAll || current.visibleDays === null) return null;
    return (
      <div className="mb-5">
        <Notice>{t('job.visibility.hidden', { days: current.visibleDays })}</Notice>
      </div>
    );
  }

  const value = draft ?? (current.visibleDays === null ? '' : String(current.visibleDays));
  const days = value.trim() === '' ? null : Number(value);
  const valid = days === null || (Number.isInteger(days) && days >= 1 && days <= current.maxDays);

  async function save(next: number | null) {
    setSaving(true);
    setFailure(null);
    const result = await apiPut<JobsVisibility>('/jobs/visibility', { visibleDays: next });
    setSaving(false);
    if (!result.ok) return setFailure(result.error);
    setSaved(result.data);
    setDraft(null);
    router.refresh();
  }

  return (
    <div className="mb-5">
      <Card title={t('job.visibility.title')} description={t('job.visibility.description')}>
        <form
          className="space-y-3 text-sm"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) void save(days);
          }}
        >
          {failure && <FormError>{describeError(failure)}</FormError>}
          <Field
            label={t('job.visibility.days')}
            hint={t('job.visibility.daysHint', { max: current.maxDays })}
            error={valid ? undefined : t('job.visibility.invalid', { max: current.maxDays })}
          >
            {(props) => (
              <TextInput
                {...props}
                inputMode="numeric"
                placeholder={t('job.visibility.off')}
                value={value}
                onChange={(event) => setDraft(event.target.value)}
                className="max-w-40"
              />
            )}
          </Field>
          <p className="text-xs text-ink-muted">
            {current.visibleDays === null
              ? t('job.visibility.nowOff')
              : t('job.visibility.nowOn', { days: current.visibleDays })}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" pending={saving} disabled={!valid}>
              {t('common.save')}
            </Button>
            {current.visibleDays !== null && (
              <Button
                type="button"
                variant="secondary"
                disabled={saving}
                onClick={() => void save(null)}
              >
                {t('job.visibility.turnOff')}
              </Button>
            )}
          </div>
        </form>
      </Card>
    </div>
  );
}

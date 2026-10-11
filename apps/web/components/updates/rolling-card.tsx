'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  NON_MIGRATABLE_POLICIES,
  REBOOT_POLICIES,
  type NonMigratablePolicy,
  type RebootPolicy,
  type RollingPlanPreview,
} from '@velnox/shared';
import { apiPost, type ApiFailure } from '@/lib/client-api';
import { useApiError } from '@/lib/use-api-error';
import { Button, Field, FormError } from '@/components/ui/form';
import { Card, Notice } from '@/components/ui/primitives';
import { useApiResource } from '@/components/server/use-api-resource';

const select =
  'block h-9 w-full rounded border border-line bg-surface-2 px-2.5 text-sm text-ink focus:border-accent focus:outline-none';

const gb = (bytes: number) => Math.round((bytes / 1024 ** 3) * 10) / 10;

/**
 * A rolling update of one cluster (Phase 7): the plan from the inventory, the
 * choices, and starting it. Whether each guest can really move live is read
 * from Proxmox when the job starts, and the job refuses there if not.
 */
export function RollingCard({ clusterId, canExecute }: { clusterId: string; canExecute: boolean }) {
  const t = useTranslations();
  const describeError = useApiError();
  const [concurrency, setConcurrency] = useState(1);
  const [reboot, setReboot] = useState<RebootPolicy>('IF_REQUIRED');
  const [nonMigratable, setNonMigratable] = useState<NonMigratablePolicy>('BLOCK');
  const [migrateBack, setMigrateBack] = useState(true);
  const [settle, setSettle] = useState(10);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const plan = useApiResource<RollingPlanPreview>(
    `/updates/clusters/${clusterId}/rolling-plan?concurrency=${concurrency}`,
  );

  async function start() {
    setPending(true);
    setFailure(null);
    const result = await apiPost<{ id: string }>(`/updates/clusters/${clusterId}/rolling`, {
      concurrency,
      rebootPolicy: reboot,
      nonMigratable,
      migrateBack,
      settleMinutes: settle,
    });
    setPending(false);
    if (!result.ok) return setFailure(result.error);
    setJobId(result.data.id);
  }

  if (plan.state !== 'ready') return null;
  const p = plan.data;
  const byNode = (node: string) => p.guests.filter((g) => g.node === node);

  return (
    <Card
      title={t('nodeUpdates.rollingTitle', { cluster: p.clusterName })}
      description={t('nodeUpdates.rollingBody')}
    >
      <div className="space-y-3">
        {failure && <FormError>{describeError(failure)}</FormError>}
        {jobId && (
          <Notice tone="ok" title={t('nodeUpdates.rollingStarted')}>
            <Link href={`/jobs/${jobId}`} className="text-accent underline">
              {t('nodeUpdates.followJob')}
            </Link>
          </Notice>
        )}
        {p.refused && (
          <Notice tone="warn" title={t('nodeUpdates.rollingRefused')}>
            {describeError({ code: p.refused.code, status: 409, params: p.refused.params })}
          </Notice>
        )}
        {p.capacityShort.map((c) => (
          <Notice key={c.node} tone="warn">
            {t('nodeUpdates.capacityShort', {
              node: c.node,
              needed: gb(c.neededBytes),
              free: gb(c.freeBytes),
            })}
          </Notice>
        ))}
        {p.groups.length > 0 && (
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            {p.groups.map((group) => (
              <li key={group.join('+')}>
                <span className="font-medium text-ink">{group.join(' + ')}</span>{' '}
                <span className="text-xs text-ink-muted">
                  {group.flatMap(byNode).length
                    ? t('nodeUpdates.guestsToMove', {
                        guests: group
                          .flatMap(byNode)
                          .map(
                            (g) =>
                              `${g.kind === 'lxc' ? 'CT' : 'VM'} ${g.vmid}${g.name ? ` (${g.name})` : ''}`,
                          )
                          .join(', '),
                      })
                    : t('nodeUpdates.noGuests')}
                </span>
              </li>
            ))}
          </ol>
        )}
        <div className="grid gap-3 md:grid-cols-2">
          <Field
            label={t('nodeUpdates.concurrency')}
            hint={t('nodeUpdates.concurrencyHint', { max: p.maxConcurrency })}
          >
            {(props) => (
              <select
                {...props}
                className={select}
                value={concurrency}
                onChange={(e) => setConcurrency(Number(e.target.value))}
              >
                {Array.from({ length: Math.max(1, p.maxConcurrency) }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={t('nodeUpdates.reboot')}>
            {(props) => (
              <select
                {...props}
                className={select}
                value={reboot}
                onChange={(e) => setReboot(e.target.value as RebootPolicy)}
              >
                {REBOOT_POLICIES.map((r) => (
                  <option key={r} value={r}>
                    {t(`nodeUpdates.rebootPolicy.${r}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={t('nodeUpdates.nonMigratable')} hint={t('nodeUpdates.nonMigratableHint')}>
            {(props) => (
              <select
                {...props}
                className={select}
                value={nonMigratable}
                onChange={(e) => setNonMigratable(e.target.value as NonMigratablePolicy)}
              >
                {NON_MIGRATABLE_POLICIES.map((n) => (
                  <option key={n} value={n}>
                    {t(`nodeUpdates.nonMigratablePolicy.${n}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={t('nodeUpdates.settle')} hint={t('nodeUpdates.settleHint')}>
            {(props) => (
              <input
                {...props}
                type="number"
                min={1}
                max={60}
                className={select}
                value={settle}
                onChange={(e) => setSettle(Number(e.target.value))}
              />
            )}
          </Field>
          <label className="flex items-start gap-2 text-sm text-ink md:col-span-2">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={migrateBack}
              onChange={(e) => setMigrateBack(e.target.checked)}
            />
            <span>
              {t('nodeUpdates.migrateBack')}
              <span className="block text-xs text-ink-muted">
                {t('nodeUpdates.migrateBackHint')}
              </span>
            </span>
          </label>
        </div>
        {canExecute && (
          <Button
            onClick={() => void start()}
            disabled={Boolean(p.refused) || pending}
            pending={pending}
          >
            {t('nodeUpdates.rollingStart')}
          </Button>
        )}
      </div>
    </Card>
  );
}

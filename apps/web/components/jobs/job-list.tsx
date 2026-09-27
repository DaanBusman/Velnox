'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { JOB_STATUSES, type JobDetail, type JobSummary } from '@velnox/shared';
import { apiPost, type ApiFailure } from '@/lib/client-api';
import { useApiError } from '@/lib/use-api-error';
import { useAutoRefresh } from '@/lib/use-auto-refresh';
import { Button, Field, FormError, TextInput } from '@/components/ui/form';
import { Card } from '@/components/ui/primitives';
import {
  JobStatusBadge,
  ProgressBar,
  durationSeconds,
  useJobTypeLabel,
} from './primitives';

/**
 * The job list.
 *
 * Re-reads itself on the viewer's refresh setting like the inventory screens,
 * because a list of jobs is a list of things changing state. It pauses while the
 * diagnostic form is open, for the reason the add-cluster form pauses it: a
 * refresh can replace the whole tree when the session has to be renewed, and a
 * half-filled form goes with it.
 */
export function JobList({
  jobs,
  status,
  canSelftest,
  refreshSeconds,
}: {
  jobs: JobSummary[];
  status: string | null;
  canSelftest: boolean;
  refreshSeconds: number;
}) {
  const t = useTranslations();
  const format = useFormatter();
  const router = useRouter();
  const typeLabel = useJobTypeLabel();
  const [launching, setLaunching] = useState(false);

  useAutoRefresh(refreshSeconds * 1000, refreshSeconds > 0 && !launching);

  const showTenant = new Set(jobs.map((job) => job.tenantId)).size > 1;

  return (
    <div className="space-y-4">
      {launching && <SelftestLauncher onCancel={() => setLaunching(false)} />}

      <Card
        title={t('job.title')}
        description={t('job.subtitle')}
        bodyClassName=""
        actions={
          <div className="flex items-center gap-2">
            <Button variant="quiet" onClick={() => router.refresh()}>
              {t('common.refresh')}
            </Button>
            {canSelftest && !launching && (
              <Button variant="secondary" onClick={() => setLaunching(true)}>
                {t('job.selftestTitle')}
              </Button>
            )}
          </div>
        }
      >
        <div className="border-b border-line px-4 py-2.5">
          <label className="flex items-center gap-2 text-xs text-ink-muted">
            {t('job.colStatus')}
            <select
              value={status ?? ''}
              onChange={(event) => {
                const next = event.target.value;
                router.push(next ? `/jobs?status=${next}` : '/jobs');
              }}
              className="h-8 rounded border border-line bg-surface px-2 text-xs text-ink"
            >
              <option value="">{t('job.allStatuses')}</option>
              {JOB_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {t(`status.job.${value.toLowerCase()}`)}
                </option>
              ))}
            </select>
          </label>
        </div>

        {jobs.length === 0 ? (
          <p className="px-4 py-6 text-sm text-ink-muted">{t('job.none')}</p>
        ) : (
          <div className="max-h-[65vh] overflow-auto">
            <table className="w-full border-collapse text-sm">
              <thead className="sticky top-0 z-10 bg-surface-2 text-left text-xs text-ink-muted shadow-[0_1px_0_var(--velnox-border)]">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">{t('job.colType')}</th>
                  <th scope="col" className="px-3 py-2 font-medium">{t('job.colStatus')}</th>
                  <th scope="col" className="w-48 px-3 py-2 font-medium">{t('job.progress')}</th>
                  {showTenant && (
                    <th scope="col" className="px-3 py-2 font-medium">{t('job.colTenant')}</th>
                  )}
                  <th scope="col" className="px-3 py-2 font-medium">{t('job.colBy')}</th>
                  <th scope="col" className="px-3 py-2 font-medium">{t('job.colQueued')}</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">{t('job.colDuration')}</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => {
                  const seconds = durationSeconds(job.startedAt, job.finishedAt);
                  return (
                    <tr key={job.id} className="border-b border-line/70 align-middle hover:bg-surface-2/50">
                      <td className="px-4 py-2.5">
                        <Link
                          href={`/jobs/${job.id}`}
                          className="font-medium text-accent underline-offset-2 hover:underline"
                        >
                          {typeLabel(job.type)}
                        </Link>
                        <span className="block font-mono text-[11px] text-ink-muted">
                          {job.concurrencyKey ?? job.id.slice(0, 8)}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        <JobStatusBadge status={job.status} />
                      </td>
                      <td className="px-3 py-2.5">
                        <ProgressBar pct={job.progressPct} label={t('job.progress')} />
                      </td>
                      {showTenant && <td className="px-3 py-2.5 text-ink-muted">{job.tenantName}</td>}
                      <td className="px-3 py-2.5 text-xs text-ink-muted">{job.createdBy?.email ?? '—'}</td>
                      <td className="px-3 py-2.5 text-xs text-ink-muted">
                        {format.relativeTime(new Date(job.queuedAt))}
                      </td>
                      <td className="px-3 py-2.5 text-right text-xs tabular-nums text-ink-muted">
                        {seconds === null ? '—' : t('job.durationSeconds', { seconds })}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

/**
 * Start a diagnostic job.
 *
 * Shown to `system.manage` only — the API refuses anyone else — and labelled
 * for what it is: something to watch the machinery with, not something that
 * does work.
 */
function SelftestLauncher({ onCancel }: { onCancel: () => void }) {
  const t = useTranslations();
  const router = useRouter();
  const describeError = useApiError();

  const [steps, setSteps] = useState('5');
  const [seconds, setSeconds] = useState('3');
  const [failAt, setFailAt] = useState('');
  const [approvalBefore, setApprovalBefore] = useState('');
  const [fourEyes, setFourEyes] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);

  const stepCount = Math.max(1, Math.min(20, Number(steps) || 1));
  const stepOptions = Array.from({ length: stepCount }, (_, index) => index + 1);

  async function start(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setFailure(null);

    const result = await apiPost<JobDetail>('/jobs/selftest', {
      steps: stepCount,
      secondsPerStep: Math.max(1, Math.min(120, Number(seconds) || 1)),
      failAtStep: failAt ? Number(failAt) : null,
      approvalBeforeStep: approvalBefore ? Number(approvalBefore) : null,
      requireDifferentApprover: fourEyes,
    });

    if (!result.ok) {
      setPending(false);
      setFailure(result.error);
      return;
    }
    router.push(`/jobs/${result.data.id}`);
  }

  const selectClass = 'h-9 w-full rounded border border-line bg-surface px-2.5 text-sm text-ink';

  return (
    <Card title={t('job.selftestTitle')} description={t('job.selftestBody')}>
      <form onSubmit={start} className="space-y-4">
        {failure && <FormError>{describeError(failure)}</FormError>}

        <div className="grid gap-3 sm:grid-cols-4">
          <Field label={t('job.selftestSteps')}>
            {(props) => (
              <TextInput
                {...props}
                type="number"
                min={1}
                max={20}
                value={steps}
                onChange={(event) => setSteps(event.target.value)}
              />
            )}
          </Field>
          <Field label={t('job.selftestSeconds')}>
            {(props) => (
              <TextInput
                {...props}
                type="number"
                min={1}
                max={120}
                value={seconds}
                onChange={(event) => setSeconds(event.target.value)}
              />
            )}
          </Field>
          <Field label={t('job.selftestFailAt')}>
            {(props) => (
              <select {...props} value={failAt} onChange={(event) => setFailAt(event.target.value)} className={selectClass}>
                <option value="">{t('job.selftestNone')}</option>
                {stepOptions.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            )}
          </Field>
          <Field label={t('job.selftestApprovalBefore')}>
            {(props) => (
              <select
                {...props}
                value={approvalBefore}
                onChange={(event) => setApprovalBefore(event.target.value)}
                className={selectClass}
              >
                <option value="">{t('job.selftestNone')}</option>
                {stepOptions.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            )}
          </Field>
        </div>

        {approvalBefore && (
          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" checked={fourEyes} onChange={(event) => setFourEyes(event.target.checked)} />
            {t('job.selftestFourEyes')}
          </label>
        )}

        <div className="flex gap-2">
          <Button type="submit" pending={pending}>
            {t('job.selftestStart')}
          </Button>
          <Button type="button" variant="quiet" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import {
  JOB_TYPES,
  type JobSummary,
  type NodeUpdatesSummary,
  type UpgradePlanSummary,
} from '@velnox/shared';
import { useApiError } from '@/lib/use-api-error';
import { Field, FormError } from '@/components/ui/form';
import { Card, StatusBadge } from '@/components/ui/primitives';
import { useApiResource } from '@/components/server/use-api-resource';
import { JobStatusBadge } from '@/components/jobs/primitives';
import { PLAN_TONE } from './upgrades-tab';

const KINDS = ['node', 'rolling', 'upgrade'] as const;
type Kind = (typeof KINDS)[number];

/** As many rows as the page shows, whichever kind is chosen. */
const SHOWN = 100;

const jobsOf = (type: string) => `/jobs?type=${encodeURIComponent(type)}&limit=${SHOWN}`;

interface Row {
  key: string;
  kind: Kind;
  when: string;
  subject: ReactNode;
  result: ReactNode;
  /** Who asked; null when a policy did, undefined when it is not known. */
  by: string | null | undefined;
}

/**
 * Everything that changed a node's packages, in one list: single node updates,
 * rolling updates of a cluster, and major upgrades.
 *
 * A major upgrade is one row per plan rather than per job, because a composite
 * plan has no job of its own and its plan page is where its report is.
 */
export function HistoryTab({ onOpenPlan }: { onOpenPlan: (planId: string) => void }) {
  const t = useTranslations();
  const format = useFormatter();
  const describeError = useApiError();
  const [kind, setKind] = useState<Kind | 'all'>('all');
  const nodeJobs = useApiResource<{ jobs: JobSummary[] }>(jobsOf(JOB_TYPES.nodeUpdate));
  const rollingJobs = useApiResource<{ jobs: JobSummary[] }>(jobsOf(JOB_TYPES.rollingUpdate));
  const upgradeJobs = useApiResource<{ jobs: JobSummary[] }>(jobsOf(JOB_TYPES.upgradeRun));
  const plans = useApiResource<{ plans: UpgradePlanSummary[] }>('/upgrades/plans');
  const nodes = useApiResource<NodeUpdatesSummary[]>('/updates/nodes');

  // Someone who may not read upgrades has none to see; that is not a failure.
  const plansHidden = plans.state === 'failed' && plans.error.status === 403;
  const sources = [nodeJobs, rollingJobs, ...(plansHidden ? [] : [upgradeJobs, plans])];
  const loading = sources.some((source) => source.state === 'loading');
  const failure = sources.find((source) => source.state === 'failed')?.error ?? null;

  const nodeName = (job: JobSummary) => {
    const found = nodes.state === 'ready' ? nodes.data.find((n) => job.targetIds.includes(n.nodeId)) : null;
    return found ? `${found.node} (${found.clusterName})` : t('nodeUpdates.aNode');
  };
  const jobLink = (job: JobSummary, label: string) => (
    <Link href={`/jobs/${job.id}`} className="text-accent underline">
      {label}
    </Link>
  );
  const fromJob = (job: JobSummary, rowKind: Kind, label: string): Row => ({
    key: job.id,
    kind: rowKind,
    when: job.queuedAt,
    subject: jobLink(job, label),
    result: <JobStatusBadge status={job.status} />,
    by: job.createdBy ? job.createdBy.email : null,
  });

  const upgradeJobList = upgradeJobs.state === 'ready' ? upgradeJobs.data.jobs : [];
  const planList = plans.state === 'ready' ? plans.data.plans : [];
  const jobIdsOf = (plan: UpgradePlanSummary) =>
    [plan.jobId, ...(plan.childJobIds ?? [])].filter((id): id is string => id !== null);
  const withPlan = new Set(planList.flatMap(jobIdsOf));
  const rows: Row[] = [
    ...(nodeJobs.state === 'ready' ? nodeJobs.data.jobs : []).map((job) =>
      fromJob(job, 'node', nodeName(job)),
    ),
    ...(rollingJobs.state === 'ready' ? rollingJobs.data.jobs : []).map((job) =>
      fromJob(job, 'rolling', job.cluster?.name ?? t('nodeUpdates.removedCluster')),
    ),
    // A plan nobody started has no history yet: it is under Major upgrades.
    ...planList
      .filter((plan) => plan.status !== 'DRAFT')
      .map((plan): Row => {
        const job = jobIdsOf(plan)
          .map((id) => upgradeJobList.find((candidate) => candidate.id === id))
          .find((candidate) => candidate !== undefined);
        return {
          key: plan.id,
          kind: 'upgrade',
          when: job?.queuedAt ?? plan.createdAt,
          subject: (
            <button className="text-left text-accent underline" onClick={() => onOpenPlan(plan.id)}>
              {plan.name} ({plan.clusterName})
            </button>
          ),
          result: (
            <StatusBadge tone={PLAN_TONE[plan.status] ?? 'neutral'}>
              {t(`upgrades.status.${plan.status}`)}
            </StatusBadge>
          ),
          by: job ? (job.createdBy ? job.createdBy.email : null) : undefined,
        };
      }),
    // Removing a cluster removes its plans, and the job stays as the record of
    // what was done: it still belongs here, opening on its output.
    ...(plans.state === 'ready' ? upgradeJobList : [])
      .filter((job) => !withPlan.has(job.id))
      .map((job) => fromJob(job, 'upgrade', job.cluster?.name ?? t('nodeUpdates.removedCluster'))),
  ].sort((a, b) => b.when.localeCompare(a.when));

  const shown = rows.filter((row) => kind === 'all' || row.kind === kind).slice(0, SHOWN);

  return (
    <Card title={t('nodeUpdates.historyTitle')} description={t('nodeUpdates.historyBody')}>
      <div className="space-y-3">
        {failure && <FormError>{describeError(failure)}</FormError>}
        <div className="max-w-xs">
          <Field label={t('nodeUpdates.historyKind')}>
            {(props) => (
              <select
                {...props}
                className="block h-9 w-full rounded border border-line bg-surface-2 px-2.5 text-sm text-ink focus:border-accent focus:outline-none"
                value={kind}
                onChange={(e) => setKind(e.target.value as Kind | 'all')}
              >
                <option value="all">{t('nodeUpdates.historyKindAll')}</option>
                {KINDS.filter((k) => k !== 'upgrade' || !plansHidden).map((k) => (
                  <option key={k} value={k}>
                    {t(`nodeUpdates.historyKindValue.${k}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        {loading ? (
          <p className="text-sm text-ink-muted">{t('common.loading')}</p>
        ) : shown.length === 0 ? (
          !failure && (
            <p className="text-sm text-ink-muted">
              {kind === 'all' ? t('nodeUpdates.noHistory') : t('nodeUpdates.noHistoryOfKind')}
            </p>
          )
        ) : (
          // A table, not a list of rows that each lay themselves out: the status,
          // the time and who asked line up down the page, however long the name.
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-ink-muted">
                  <th className="py-2 pr-3 font-medium">{t('nodeUpdates.historyKind')}</th>
                  <th className="py-2 pr-3 font-medium">{t('nodeUpdates.historySubject')}</th>
                  <th className="py-2 pr-3 font-medium">{t('nodeUpdates.historyResult')}</th>
                  <th className="py-2 pr-3 font-medium">{t('nodeUpdates.historyWhen')}</th>
                  <th className="py-2 font-medium">{t('nodeUpdates.historyBy')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {shown.map((row) => (
                  <tr key={row.key}>
                    <td className="whitespace-nowrap py-2 pr-3 text-ink-muted">
                      {t(`nodeUpdates.historyKindValue.${row.kind}`)}
                    </td>
                    <td className="py-2 pr-3">{row.subject}</td>
                    <td className="whitespace-nowrap py-2 pr-3">{row.result}</td>
                    <td className="whitespace-nowrap py-2 pr-3 tabular-nums text-ink-muted">
                      {format.dateTime(new Date(row.when), 'medium')}
                    </td>
                    <td className="py-2 text-ink-muted">
                      {row.by === undefined ? '—' : (row.by ?? t('nodeUpdates.historyPolicy'))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}

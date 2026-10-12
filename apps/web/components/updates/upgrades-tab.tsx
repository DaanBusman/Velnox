'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import {
  CEPH_CHANNELS,
  CEPH_MATRIX,
  fileDiff,
  type CheckSeverity,
  type JobStatus,
  type UpgradePlanDetail,
  type UpgradePlanSummary,
  type UpgradePlaybookDef,
} from '@velnox/shared';
import { apiDelete, apiPost, type ApiFailure } from '@/lib/client-api';
import { useApiError } from '@/lib/use-api-error';
import type { ClusterSummary } from '@/lib/session-types';
import { Button, Field, FormError, TextInput } from '@/components/ui/form';
import { Card, Notice, StatusBadge, type StatusTone } from '@/components/ui/primitives';
import { useApiResource } from '@/components/server/use-api-resource';
import { JobStatusBadge } from '@/components/jobs/primitives';

const select =
  'block h-9 w-full rounded border border-line bg-surface-2 px-2.5 text-sm text-ink focus:border-accent focus:outline-none';

type Playbook = Pick<
  UpgradePlaybookDef,
  'id' | 'version' | 'title' | 'kind' | 'targetKind' | 'internal'
>;

const PLAN_TONE: Record<string, StatusTone> = {
  DRAFT: 'neutral',
  RUNNING: 'neutral',
  WAITING_APPROVAL: 'warn',
  BLOCKED: 'error',
  COMPLETED: 'ok',
  FAILED: 'error',
  CANCELLED: 'unknown',
};
const SEVERITY_TONE: Record<CheckSeverity, StatusTone> = {
  PASS: 'ok',
  INFO: 'neutral',
  WARNING: 'warn',
  BLOCKER: 'error',
  UNKNOWN: 'error',
};

/**
 * Major upgrades (Phase 8): plans, each run of their checks, their
 * remediations with the exact change, composites with their children, and the
 * report. Until Phases 9A and 9B add Ceph and PVE playbooks, the only
 * playbooks are the engine's self-tests, offered to those who manage the
 * installation.
 */
export function UpgradesTab({
  clusters,
  canExecute,
}: {
  clusters: ClusterSummary[];
  canExecute: boolean;
}) {
  const t = useTranslations();
  const format = useFormatter();
  const plans = useApiResource<{ plans: UpgradePlanSummary[] }>('/upgrades/plans');
  const playbooks = useApiResource<{ playbooks: Playbook[] }>('/upgrades/playbooks');
  const [open, setOpen] = useState<string | null>(null);
  const offered = playbooks.state === 'ready' ? playbooks.data.playbooks : [];

  return (
    <div className="space-y-4">
      {canExecute && offered.length > 0 && (
        <NewPlan
          clusters={clusters}
          playbooks={offered}
          onCreated={(id) => (plans.reload(), setOpen(id))}
        />
      )}
      {offered.length === 0 && playbooks.state === 'ready' && (
        <Notice>{t('upgrades.noPlaybooks')}</Notice>
      )}
      <Card title={t('upgrades.plansTitle')} description={t('upgrades.plansBody')}>
        {plans.state !== 'ready' ? (
          <p className="text-sm text-ink-muted">{t('common.loading')}</p>
        ) : plans.data.plans.length === 0 ? (
          <p className="text-sm text-ink-muted">{t('upgrades.noPlans')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {plans.data.plans.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <button
                  className="font-medium text-accent underline"
                  onClick={() => setOpen(open === p.id ? null : p.id)}
                >
                  {p.name}
                </button>
                <StatusBadge tone={PLAN_TONE[p.status] ?? 'neutral'}>
                  {t(`upgrades.status.${p.status}`)}
                </StatusBadge>
                <span className="text-xs text-ink-muted">
                  {p.clusterName} · {p.playbookTitle ?? t('upgrades.composite')} ·{' '}
                  {format.dateTime(new Date(p.createdAt), 'medium')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {open && (
        <PlanDetail
          key={open}
          id={open}
          canExecute={canExecute}
          onChanged={plans.reload}
          onOpen={setOpen}
        />
      )}
    </div>
  );
}

function NewPlan({
  clusters,
  playbooks,
  onCreated,
}: {
  clusters: ClusterSummary[];
  playbooks: Playbook[];
  onCreated: (id: string) => void;
}) {
  const t = useTranslations();
  const describeError = useApiError();
  const [clusterId, setClusterId] = useState(clusters[0]?.id ?? '');
  const [name, setName] = useState('');
  const [playbookId, setPlaybookId] = useState(playbooks[0]?.id ?? '');
  const [composite, setComposite] = useState(false);
  const [configOld, setConfigOld] = useState(true);
  const [unfixable, setUnfixable] = useState(false);
  const [target, setTarget] = useState('squid');
  const [channel, setChannel] = useState<'no-subscription' | 'enterprise'>('no-subscription');
  const [mdsPrepared, setMdsPrepared] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [pending, setPending] = useState(false);
  const kind = playbooks.find((p) => p.id === playbookId)?.kind;
  const selftest = kind === 'SELFTEST';
  const ceph = kind === 'CEPH';
  const options = { markerMissing: true, configOld, unfixable, failTarget: null };

  async function create() {
    setPending(true);
    setFailure(null);
    const body = composite
      ? {
          kind: 'COMPOSITE',
          clusterId,
          name,
          children: playbooks
            .filter((p) => p.kind === 'SELFTEST')
            .sort((a) => (a.targetKind === 'CEPH_DAEMON' ? -1 : 1))
            .map((p) => ({ name: `${name} — ${p.title}`, playbookId: p.id, options })),
        }
      : {
          kind: 'PLAYBOOK',
          clusterId,
          name,
          playbookId,
          options: selftest ? options : ceph ? { target, channel, mdsPrepared } : {},
        };
    const result = await apiPost<UpgradePlanDetail>('/upgrades/plans', body);
    setPending(false);
    if (!result.ok) return setFailure(result.error);
    setName('');
    onCreated(result.data.id);
  }

  return (
    <Card title={t('upgrades.newTitle')} description={t('upgrades.newBody')}>
      <div className="space-y-3">
        {failure && <FormError>{describeError(failure)}</FormError>}
        <div className="grid gap-3 md:grid-cols-3">
          <Field label={t('upgrades.cluster')}>
            {(props) => (
              <select
                {...props}
                className={select}
                value={clusterId}
                onChange={(e) => setClusterId(e.target.value)}
              >
                {clusters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={t('upgrades.playbook')}>
            {(props) => (
              <select
                {...props}
                className={select}
                value={playbookId}
                disabled={composite}
                onChange={(e) => setPlaybookId(e.target.value)}
              >
                {playbooks.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={t('upgrades.name')}>
            {(props) => (
              <TextInput {...props} value={name} onChange={(e) => setName(e.target.value)} />
            )}
          </Field>
        </div>
        {ceph && (
          <div className="grid gap-3 md:grid-cols-3">
            <Field label={t('upgrades.cephTarget')} hint={t('upgrades.cephTargetHint')}>
              {(props) => (
                <select
                  {...props}
                  className={select}
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                >
                  {CEPH_MATRIX.map((m) => (
                    <option key={m.to} value={m.to}>
                      {t('upgrades.cephStep', { from: m.from, to: m.to })}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label={t('upgrades.cephChannel')}>
              {(props) => (
                <select
                  {...props}
                  className={select}
                  value={channel}
                  onChange={(e) => setChannel(e.target.value as typeof channel)}
                >
                  {CEPH_CHANNELS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <label className="flex items-start gap-2 text-sm text-ink">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={mdsPrepared}
                onChange={(e) => setMdsPrepared(e.target.checked)}
              />
              <span>
                {t('upgrades.cephMds')}
                <span className="block text-xs text-ink-muted">{t('upgrades.cephMdsHint')}</span>
              </span>
            </label>
          </div>
        )}
        {selftest && (
          <div className="flex flex-wrap gap-4 text-sm text-ink">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={composite}
                onChange={(e) => setComposite(e.target.checked)}
              />
              {t('upgrades.selftestComposite')}
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={configOld}
                onChange={(e) => setConfigOld(e.target.checked)}
              />
              {t('upgrades.selftestApproval')}
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={unfixable}
                onChange={(e) => setUnfixable(e.target.checked)}
              />
              {t('upgrades.selftestUnfixable')}
            </label>
          </div>
        )}
        <Button
          onClick={() => void create()}
          pending={pending}
          disabled={pending || !name || !clusterId}
        >
          {t('upgrades.create')}
        </Button>
      </div>
    </Card>
  );
}

function PlanDetail({
  id,
  canExecute,
  onChanged,
  onOpen,
}: {
  id: string;
  canExecute: boolean;
  onChanged: () => void;
  onOpen: (id: string) => void;
}) {
  const t = useTranslations();
  const describeError = useApiError();
  const resource = useApiResource<UpgradePlanDetail>(`/upgrades/plans/${id}`);
  const last = useRef<UpgradePlanDetail | null>(null);
  if (resource.state === 'ready') last.current = resource.data;
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [pending, setPending] = useState(false);
  const plan = last.current;
  if (!plan) {
    if (resource.state === 'failed') return <FormError>{describeError(resource.error)}</FormError>;
    return <p className="text-sm text-ink-muted">{t('common.loading')}</p>;
  }
  const labelOf = (targetId: string | null) =>
    targetId
      ? (plan.targetList.find((x) => x.id === targetId)?.label ?? '—')
      : t('upgrades.wholePlan');
  const runs = [...new Set(plan.checks.map((c) => c.runIndex))].sort();

  async function act(kind: 'run' | 'remove') {
    setPending(true);
    setFailure(null);
    const result =
      kind === 'run'
        ? await apiPost(`/upgrades/plans/${id}/run`)
        : await apiDelete(`/upgrades/plans/${id}`);
    setPending(false);
    if (!result.ok) return setFailure(result.error);
    onChanged();
    if (kind === 'remove') onOpen('');
    else resource.reload();
  }

  return (
    <Card
      title={plan.name}
      description={`${plan.clusterName} · ${plan.playbookTitle ?? t('upgrades.composite')}`}
      actions={
        <span className="flex items-center gap-2">
          <StatusBadge tone={PLAN_TONE[plan.status] ?? 'neutral'}>
            {t(`upgrades.status.${plan.status}`)}
          </StatusBadge>
          {plan.jobStatus && <JobStatusBadge status={plan.jobStatus as JobStatus} />}
          <Button variant="quiet" onClick={resource.reload}>
            {t('upgrades.refresh')}
          </Button>
        </span>
      }
    >
      <div className="space-y-4 text-sm">
        {failure && <FormError>{describeError(failure)}</FormError>}
        {plan.jobId && (
          <Link href={`/jobs/${plan.jobId}`} className="text-accent underline">
            {t('upgrades.followJob')}
          </Link>
        )}
        {canExecute && plan.status === 'DRAFT' && !plan.parentPlanId && (
          <div className="flex gap-2">
            <Button onClick={() => void act('run')} pending={pending} disabled={pending}>
              {t('upgrades.start')}
            </Button>
            <Button variant="quiet" onClick={() => void act('remove')} disabled={pending}>
              {t('upgrades.remove')}
            </Button>
          </div>
        )}

        {plan.children.length > 0 && (
          <section>
            <h3 className="mb-1 font-medium text-ink">{t('upgrades.children')}</h3>
            <ol className="list-decimal space-y-1 pl-5">
              {plan.children.map((c) => (
                <li key={c.id}>
                  <button className="text-accent underline" onClick={() => onOpen(c.id)}>
                    {c.name}
                  </button>{' '}
                  <StatusBadge tone={PLAN_TONE[c.status] ?? 'neutral'}>
                    {t(`upgrades.status.${c.status}`)}
                  </StatusBadge>
                </li>
              ))}
            </ol>
          </section>
        )}

        {plan.targetList.length > 0 && (
          <section>
            <h3 className="mb-1 font-medium text-ink">
              {plan.targetList[0]!.kind === 'NODE' ? t('upgrades.nodes') : t('upgrades.daemons')}
            </h3>
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-ink-muted">
                <tr>
                  <th className="py-1">{t('upgrades.target')}</th>
                  <th>{t('upgrades.targetStatus')}</th>
                  <th>{t('upgrades.before')}</th>
                  <th>{t('upgrades.after')}</th>
                </tr>
              </thead>
              <tbody>
                {plan.targetList.map((x) => (
                  <tr key={x.id} className="border-t border-line">
                    <td className="py-1">
                      {x.label}
                      {x.group ? (
                        <span className="text-xs text-ink-muted"> ({x.group})</span>
                      ) : null}
                    </td>
                    <td>{x.status}</td>
                    <td>{x.preState ? JSON.stringify(x.preState) : '—'}</td>
                    <td>{x.postState ? JSON.stringify(x.postState) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {runs.map((run) => (
          <section key={run}>
            <h3 className="mb-1 font-medium text-ink">
              {run === 0 ? t('upgrades.preflight') : t('upgrades.recheck', { run })}
            </h3>
            <ul className="space-y-1">
              {plan.checks
                .filter((c) => c.runIndex === run)
                .map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-2">
                    <StatusBadge tone={SEVERITY_TONE[c.severity]}>{c.severity}</StatusBadge>
                    <span className="text-ink">{c.title}</span>
                    <span className="text-xs text-ink-muted">{labelOf(c.targetId)}</span>
                    {c.rawLine && <code className="text-xs text-ink-muted">{c.rawLine}</code>}
                  </li>
                ))}
            </ul>
          </section>
        ))}

        {plan.remediations.length > 0 && (
          <section>
            <h3 className="mb-1 font-medium text-ink">{t('upgrades.remediations')}</h3>
            <ul className="space-y-2">
              {plan.remediations.map((r) => (
                <li key={r.id} className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-ink">{r.title}</span>
                    <StatusBadge tone={r.mode === 'AUTOMATIC' ? 'neutral' : 'warn'}>
                      {t(`upgrades.mode.${r.mode}`)}
                    </StatusBadge>
                    <StatusBadge
                      tone={
                        r.status === 'FAILED'
                          ? 'error'
                          : r.status === 'VALIDATED'
                            ? 'ok'
                            : 'neutral'
                      }
                    >
                      {r.status}
                    </StatusBadge>
                    <span className="text-xs text-ink-muted">
                      {labelOf(r.targetId)} · {t('upgrades.risk', { risk: r.risk })}
                    </span>
                  </div>
                  {r.changeSet?.files.map((f) => (
                    <pre
                      key={f.path}
                      className="overflow-x-auto rounded bg-surface-2 p-2 text-xs text-ink"
                    >
                      {fileDiff(f)}
                    </pre>
                  ))}
                  {r.error && <p className="text-xs text-error">{r.error}</p>}
                </li>
              ))}
            </ul>
          </section>
        )}

        {plan.report && (
          <section>
            <div className="mb-1 flex items-center gap-2">
              <h3 className="font-medium text-ink">{t('upgrades.report')}</h3>
              <a
                className="text-xs text-accent underline"
                download={`${plan.name.replace(/[^A-Za-z0-9._-]+/g, '-')}.md`}
                href={`data:text/markdown;charset=utf-8,${encodeURIComponent(plan.report.markdown)}`}
              >
                {t('upgrades.downloadReport')}
              </a>
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-surface-2 p-3 text-xs text-ink">
              {plan.report.markdown}
            </pre>
          </section>
        )}
      </div>
    </Card>
  );
}

'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import {
  PLACEMENT_KINDS,
  type JobStatus,
  type PlacementClusterView,
  type PlacementKind,
  type PlacementRuleInput,
  type PlacementRuleView,
  type PlacementSettingsInput,
} from '@velnox/shared';
import { apiDelete, apiPost, apiPut, type ApiFailure } from '@/lib/client-api';
import { useApiError } from '@/lib/use-api-error';
import type { ClusterSummary } from '@/lib/session-types';
import { Button, Field, FormError, TextInput } from '@/components/ui/form';
import { Card, Notice, StatusBadge } from '@/components/ui/primitives';
import { useApiResource } from '@/components/server/use-api-resource';
import { JobStatusBadge } from '@/components/jobs/primitives';

const select =
  'block h-9 w-full rounded border border-line bg-surface-2 px-2.5 text-sm text-ink focus:border-accent focus:outline-none';

type Guest = PlacementClusterView['guests'][number];
const guestLabel = (g: Pick<Guest, 'vmid' | 'kind' | 'name'>) =>
  `${g.kind === 'lxc' ? 'CT' : 'VM'} ${g.vmid}${g.name ? ` (${g.name})` : ''}`;

/**
 * Placement (Phase 7B): which guests of a cluster are kept apart or together,
 * which nodes a guest belongs on, whether that holds now, and how Velnox keeps
 * it so.
 */
export function PlacementView({ clusters }: { clusters: ClusterSummary[] }) {
  const t = useTranslations();
  const [clusterId, setClusterId] = useState(clusters.length === 1 ? clusters[0]!.id : '');
  return (
    <div className="space-y-4">
      <div className="max-w-sm">
        <Field label={t('placement.cluster')}>
          {(props) => (
            <select
              {...props}
              className={select}
              value={clusterId}
              onChange={(e) => setClusterId(e.target.value)}
            >
              <option value="">{t('placement.chooseCluster')}</option>
              {clusters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      {clusterId ? (
        <ClusterPlacement key={clusterId} clusterId={clusterId} />
      ) : (
        <Notice>{t('placement.chooseClusterBody')}</Notice>
      )}
    </div>
  );
}

function ClusterPlacement({ clusterId }: { clusterId: string }) {
  const t = useTranslations();
  const format = useFormatter();
  const describeError = useApiError();
  const resource = useApiResource<PlacementClusterView>(`/placement/clusters/${clusterId}`);
  const last = useRef<PlacementClusterView | null>(null);
  if (resource.state === 'ready') last.current = resource.data;
  const [editing, setEditing] = useState<PlacementRuleView | 'new' | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [started, setStarted] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const view = last.current;
  if (!view) {
    if (resource.state === 'failed') return <FormError>{describeError(resource.error)}</FormError>;
    return <p className="text-sm text-ink-muted">{t('common.loading')}</p>;
  }
  const byVmid = new Map(view.guests.map((g) => [g.vmid, g]));
  const label = (vmid: number) => {
    const g = byVmid.get(vmid);
    return g ? guestLabel(g) : `#${vmid}`;
  };

  async function run(reason: 'correct' | 'balance') {
    setPending(reason);
    setFailure(null);
    const result = await apiPost<{ id: string }>(`/placement/clusters/${clusterId}/${reason}`);
    setPending(null);
    if (!result.ok) return setFailure(result.error);
    setStarted(result.data.id);
    resource.reload();
  }

  async function remove(rule: PlacementRuleView) {
    setFailure(null);
    const result = await apiDelete(`/placement/rules/${rule.id}`);
    if (!result.ok) return setFailure(result.error);
    resource.reload();
  }

  return (
    <div className="space-y-4">
      {failure && <FormError>{describeError(failure)}</FormError>}
      {started && (
        <Notice tone="ok" title={t('placement.started')}>
          <Link href={`/jobs/${started}`} className="text-accent underline">
            {t('placement.followJob')}
          </Link>
        </Notice>
      )}
      <Notice tone={view.cluster.haRules ? 'ok' : 'neutral'}>
        {view.cluster.haRules ? t('placement.haRulesOn') : t('placement.haRulesOff')}
      </Notice>
      {!view.cluster.whole && <Notice tone="warn">{t('placement.notWhole')}</Notice>}

      <Card
        title={t('placement.rulesTitle', { cluster: view.cluster.name })}
        description={t('placement.rulesBody')}
        actions={
          view.canManage && editing === null ? (
            <Button variant="secondary" onClick={() => setEditing('new')}>
              {t('placement.newRule')}
            </Button>
          ) : null
        }
      >
        {editing !== null && (
          <RuleForm
            clusterId={clusterId}
            view={view}
            rule={editing === 'new' ? null : editing}
            onDone={() => {
              setEditing(null);
              resource.reload();
            }}
          />
        )}
        {view.rules.length === 0 && editing === null && (
          <p className="text-sm text-ink-muted">{t('placement.noRules')}</p>
        )}
        <ul className="divide-y divide-line">
          {view.rules.map((rule) => (
            <li key={rule.id} className="space-y-1 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-ink">{rule.name}</span>
                <StatusBadge tone="neutral">{t(`placement.kind.${rule.kind}`)}</StatusBadge>
                {!rule.enabled ? (
                  <StatusBadge tone="unknown">{t('placement.disabled')}</StatusBadge>
                ) : rule.violations.length ? (
                  <StatusBadge tone={rule.violations.every((v) => v.soft) ? 'warn' : 'error'}>
                    {t('placement.notMet')}
                  </StatusBadge>
                ) : (
                  <StatusBadge tone="ok">{t('placement.holds')}</StatusBadge>
                )}
                <StatusBadge
                  tone={
                    rule.ha.state === 'synced'
                      ? 'ok'
                      : rule.ha.state === 'error'
                        ? 'error'
                        : 'neutral'
                  }
                >
                  {t(`placement.ha.${rule.ha.state}`)}
                </StatusBadge>
                {view.canManage && (
                  <span className="ml-auto flex gap-1">
                    <Button variant="quiet" onClick={() => setEditing(rule)}>
                      {t('placement.edit')}
                    </Button>
                    <Button variant="quiet" onClick={() => void remove(rule)}>
                      {t('placement.remove')}
                    </Button>
                  </span>
                )}
              </div>
              <p className="text-sm text-ink">
                {rule.kind === 'PREFER_NODES'
                  ? t(rule.strict ? 'placement.preferStrict' : 'placement.preferSoft', {
                      guests: rule.vmids.map(label).join(', '),
                      nodes: rule.nodes.join(', '),
                    })
                  : t(`placement.describe.${rule.kind}`, {
                      guests: rule.vmids.map(label).join(', '),
                    })}
              </p>
              {rule.enabled &&
                rule.violations.map((v) => (
                  <p key={v.vmids.join('-')} className="text-xs text-error">
                    {rule.kind === 'KEEP_APART'
                      ? t('placement.violation.apart', {
                          guests: v.vmids.map(label).join(', '),
                          node: byVmid.get(v.vmids[0]!)?.node ?? '—',
                        })
                      : t('placement.violation.elsewhere', {
                          where: v.vmids
                            .map((id) =>
                              t('placement.onNode', {
                                guest: label(id),
                                node: byVmid.get(id)?.node ?? '—',
                              }),
                            )
                            .join(', '),
                        })}
                  </p>
                ))}
              {rule.ha.state === 'error' && rule.ha.error && (
                <p className="text-xs text-error">
                  {t('placement.haError', { error: rule.ha.error })}
                </p>
              )}
            </li>
          ))}
        </ul>
      </Card>

      {view.canManage && (
        <Card title={t('placement.nowTitle')} description={t('placement.nowBody')}>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => void run('correct')}
              pending={pending === 'correct'}
              disabled={pending !== null || !view.cluster.whole}
            >
              {t('placement.correctNow')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => void run('balance')}
              pending={pending === 'balance'}
              disabled={pending !== null || !view.cluster.whole}
            >
              {t('placement.balanceNow')}
            </Button>
          </div>
          <ul className="mt-3 grid gap-1 text-xs text-ink-muted sm:grid-cols-2">
            {view.nodes.map((n) => (
              <li key={n.name}>
                {n.online
                  ? t('placement.nodeMemory', {
                      node: n.name,
                      percent: n.memoryUsedPercent ?? '—',
                    })
                  : t('placement.nodeOffline', { node: n.name })}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <SettingsCard
        clusterId={clusterId}
        settings={view.settings}
        canManage={view.canManage}
        onSaved={resource.reload}
      />

      <Card title={t('placement.historyTitle')}>
        {view.jobs.length === 0 ? (
          <p className="text-sm text-ink-muted">{t('placement.noJobs')}</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {view.jobs.map((job) => (
              <li key={job.id} className="flex flex-wrap items-center gap-2 py-2">
                <JobStatusBadge status={job.status as JobStatus} />
                <Link href={`/jobs/${job.id}`} className="text-accent underline">
                  {t(`placement.reason.${job.reason ?? 'correct'}`)}
                </Link>
                <span className="text-xs text-ink-muted">
                  {format.dateTime(new Date(job.queuedAt), 'medium')}
                  {job.by ? ` · ${t('placement.bySettings')}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function RuleForm({
  clusterId,
  view,
  rule,
  onDone,
}: {
  clusterId: string;
  view: PlacementClusterView;
  rule: PlacementRuleView | null;
  onDone: () => void;
}) {
  const t = useTranslations();
  const describeError = useApiError();
  const [name, setName] = useState(rule?.name ?? '');
  const [kind, setKind] = useState<PlacementKind>(rule?.kind ?? 'KEEP_APART');
  const [vmids, setVmids] = useState<number[]>(rule?.vmids ?? []);
  const [nodes, setNodes] = useState<string[]>(rule?.nodes ?? []);
  const [strict, setStrict] = useState(rule?.strict ?? true);
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [pending, setPending] = useState(false);
  const toggle = <T,>(list: T[], value: T) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  async function save() {
    setPending(true);
    setFailure(null);
    const body: PlacementRuleInput = {
      name,
      kind,
      vmids,
      nodes: kind === 'PREFER_NODES' ? nodes : [],
      strict,
      enabled,
    };
    const result = rule
      ? await apiPut(`/placement/rules/${rule.id}`, body)
      : await apiPost(`/placement/clusters/${clusterId}/rules`, body);
    setPending(false);
    if (!result.ok) return setFailure(result.error);
    onDone();
  }

  return (
    <div className="mb-4 space-y-3 rounded border border-line p-3">
      {failure && <FormError>{describeError(failure)}</FormError>}
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={t('placement.name')}>
          {(props) => (
            <TextInput {...props} value={name} onChange={(e) => setName(e.target.value)} />
          )}
        </Field>
        <Field label={t('placement.kindLabel')}>
          {(props) => (
            <select
              {...props}
              className={select}
              value={kind}
              onChange={(e) => setKind(e.target.value as PlacementKind)}
            >
              {PLACEMENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`placement.kind.${k}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <p className="text-xs text-ink-muted">{t(`placement.kindHint.${kind}`)}</p>
      <fieldset>
        <legend className="mb-1 text-sm font-medium text-ink">{t('placement.guests')}</legend>
        <div className="grid max-h-56 gap-1 overflow-y-auto sm:grid-cols-2">
          {view.guests.map((g) => (
            <label key={g.vmid} className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={vmids.includes(g.vmid)}
                onChange={() => setVmids(toggle(vmids, g.vmid))}
              />
              <span>
                {guestLabel(g)}{' '}
                <span className="text-xs text-ink-muted">
                  {g.running
                    ? t('placement.runningOn', { node: g.node ?? '—' })
                    : t('placement.stopped')}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {kind === 'PREFER_NODES' && (
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium text-ink">{t('placement.nodes')}</legend>
          <div className="flex flex-wrap gap-3">
            {view.nodes.map((n) => (
              <label key={n.name} className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={nodes.includes(n.name)}
                  onChange={() => setNodes(toggle(nodes, n.name))}
                />
                {n.name}
              </label>
            ))}
          </div>
          <label className="flex items-start gap-2 text-sm text-ink">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={strict}
              onChange={(e) => setStrict(e.target.checked)}
            />
            <span>
              {t('placement.strict')}
              <span className="block text-xs text-ink-muted">{t('placement.strictHint')}</span>
            </span>
          </label>
        </fieldset>
      )}
      <label className="flex items-center gap-2 text-sm text-ink">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        {t('placement.enabled')}
      </label>
      <div className="flex gap-2">
        <Button onClick={() => void save()} pending={pending} disabled={pending}>
          {t('common.save')}
        </Button>
        <Button variant="quiet" onClick={onDone}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
}

function SettingsCard({
  clusterId,
  settings,
  canManage,
  onSaved,
}: {
  clusterId: string;
  settings: PlacementSettingsInput;
  canManage: boolean;
  onSaved: () => void;
}) {
  const t = useTranslations();
  const describeError = useApiError();
  const [value, setValue] = useState(settings);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);

  async function save() {
    setPending(true);
    setFailure(null);
    setSaved(false);
    const result = await apiPut(`/placement/clusters/${clusterId}/settings`, value);
    setPending(false);
    if (!result.ok) return setFailure(result.error);
    setSaved(true);
    onSaved();
  }

  return (
    <Card title={t('placement.settingsTitle')} description={t('placement.settingsBody')}>
      <div className="space-y-3">
        {failure && <FormError>{describeError(failure)}</FormError>}
        {saved && <Notice tone="ok">{t('placement.settingsSaved')}</Notice>}
        <label className="flex items-start gap-2 text-sm text-ink">
          <input
            type="checkbox"
            className="mt-0.5"
            disabled={!canManage}
            checked={value.autoCorrect}
            onChange={(e) => setValue({ ...value, autoCorrect: e.target.checked })}
          />
          <span>
            {t('placement.autoCorrect')}
            <span className="block text-xs text-ink-muted">{t('placement.autoCorrectHint')}</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm text-ink">
          <input
            type="checkbox"
            className="mt-0.5"
            disabled={!canManage}
            checked={value.balance}
            onChange={(e) => setValue({ ...value, balance: e.target.checked })}
          />
          <span>
            {t('placement.balance')}
            <span className="block text-xs text-ink-muted">{t('placement.balanceHint')}</span>
          </span>
        </label>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label={t('placement.threshold')} hint={t('placement.thresholdHint')}>
            {(props) => (
              <TextInput
                {...props}
                type="number"
                min={5}
                max={80}
                disabled={!canManage}
                value={value.balanceThresholdPercent}
                onChange={(e) =>
                  setValue({ ...value, balanceThresholdPercent: Number(e.target.value) })
                }
              />
            )}
          </Field>
          <Field label={t('placement.quiet')} hint={t('placement.quietHint')}>
            {(props) => (
              <TextInput
                {...props}
                type="number"
                min={5}
                max={1440}
                disabled={!canManage}
                value={value.quietMinutes}
                onChange={(e) => setValue({ ...value, quietMinutes: Number(e.target.value) })}
              />
            )}
          </Field>
        </div>
        {canManage && (
          <Button onClick={() => void save()} pending={pending} disabled={pending}>
            {t('common.save')}
          </Button>
        )}
      </div>
    </Card>
  );
}

'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import {
  REBOOT_POLICIES,
  WEEKDAYS,
  ruleProblem,
  windowState,
  type JobSummary,
  type MaintenanceWindowSummary,
  type NodeUpdatesSummary,
  type PendingPackage,
  type RebootPolicy,
  type UpdatePolicySummary,
} from '@velnox/shared';
import { apiDelete, apiPost, apiPut, type ApiFailure } from '@/lib/client-api';
import { useApiError } from '@/lib/use-api-error';
import type { ClusterSummary, TenantSummary } from '@/lib/session-types';
import { Button, Field, FormError, TextInput } from '@/components/ui/form';
import { Card, Notice, StatusBadge } from '@/components/ui/primitives';
import { useApiResource } from '@/components/server/use-api-resource';
import { JobStatusBadge } from '@/components/jobs/primitives';
import { RollingCard } from './rolling-card';

const select =
  'block h-9 w-full rounded border border-line bg-surface-2 px-2.5 text-sm text-ink focus:border-accent focus:outline-none';

type Tab = 'nodes' | 'policies' | 'windows' | 'history';

/**
 * Update management (Phase 6): what each node would update, updating one,
 * the policies that decide when, and the windows they run in.
 */
export function UpdatesView({
  clusters,
  tenants,
  canExecute,
  canManage,
}: {
  clusters: ClusterSummary[];
  tenants: TenantSummary[];
  canExecute: boolean;
  canManage: boolean;
}) {
  const t = useTranslations();
  const [tab, setTab] = useState<Tab>('nodes');
  const tabs: Tab[] = ['nodes', 'policies', 'windows', 'history'];
  return (
    <div className="space-y-4">
      <div role="tablist" className="flex flex-wrap gap-1 border-b border-line">
        {tabs.map((key) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${
              tab === key
                ? 'border-accent text-ink'
                : 'border-transparent text-ink-muted hover:text-ink'
            }`}
          >
            {t(`nodeUpdates.tab.${key}`)}
          </button>
        ))}
      </div>
      {tab === 'nodes' && <NodesTab clusters={clusters} canExecute={canExecute} />}
      {tab === 'policies' && <PoliciesTab clusters={clusters} canManage={canManage} />}
      {tab === 'windows' && <WindowsTab tenants={tenants} canManage={canManage} />}
      {tab === 'history' && <HistoryTab />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

function NodesTab({ clusters, canExecute }: { clusters: ClusterSummary[]; canExecute: boolean }) {
  const t = useTranslations();
  const format = useFormatter();
  const describeError = useApiError();
  const [clusterId, setClusterId] = useState('');
  const nodes = useApiResource<NodeUpdatesSummary[]>(
    `/updates/nodes${clusterId ? `?clusterId=${clusterId}` : ''}`,
  );
  const [open, setOpen] = useState<string | null>(null);
  const [running, setRunning] = useState<NodeUpdatesSummary | null>(null);
  const [reboot, setReboot] = useState<RebootPolicy>('IF_REQUIRED');
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [started, setStarted] = useState<{ node: string; jobId: string } | null>(null);
  const [pending, setPending] = useState(false);

  async function run() {
    if (!running) return;
    setPending(true);
    setFailure(null);
    const result = await apiPost<{ id: string }>(`/updates/nodes/${running.nodeId}/run`, {
      rebootPolicy: reboot,
    });
    setPending(false);
    if (!result.ok) return setFailure(result.error);
    setStarted({ node: running.node, jobId: result.data.id });
    setRunning(null);
    nodes.reload();
  }

  return (
    <div className="space-y-4">
      {failure && <FormError>{describeError(failure)}</FormError>}
      {started && (
        <Notice tone="ok" title={t('nodeUpdates.started', { node: started.node })}>
          <Link href={`/jobs/${started.jobId}`} className="text-accent underline">
            {t('nodeUpdates.followJob')}
          </Link>
        </Notice>
      )}
      <div className="max-w-sm">
        <Field label={t('nodeUpdates.cluster')}>
          {(props) => (
            <select
              {...props}
              className={select}
              value={clusterId}
              onChange={(e) => setClusterId(e.target.value)}
            >
              <option value="">{t('nodeUpdates.allClusters')}</option>
              {clusters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} — {c.tenantName}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>

      {running && (
        <Card
          title={t('nodeUpdates.runTitle', { node: running.node })}
          description={t('nodeUpdates.runBody')}
        >
          <div className="space-y-3">
            <Field label={t('nodeUpdates.reboot')} hint={t('nodeUpdates.rebootHint')}>
              {(props) => (
                <select
                  {...props}
                  className={select}
                  value={reboot}
                  onChange={(e) => setReboot(e.target.value as RebootPolicy)}
                >
                  {REBOOT_POLICIES.map((p) => (
                    <option key={p} value={p}>
                      {t(`nodeUpdates.rebootPolicy.${p}`)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {running.policy && (
              <p className="text-xs text-ink-muted">
                {t('nodeUpdates.policyApplies', { policy: running.policy.name })}
              </p>
            )}
            <div className="flex gap-2">
              <Button onClick={() => void run()} pending={pending} disabled={pending}>
                {t('nodeUpdates.runNow')}
              </Button>
              <Button variant="secondary" onClick={() => setRunning(null)}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {clusterId && <RollingCard clusterId={clusterId} canExecute={canExecute} />}

      <Card title={t('nodeUpdates.nodesTitle')} description={t('nodeUpdates.nodesBody')}>
        {nodes.state === 'loading' ? (
          <p className="text-sm text-ink-muted">{t('common.loading')}</p>
        ) : nodes.state === 'failed' ? (
          <Notice tone="error">{describeError(nodes.error)}</Notice>
        ) : nodes.data.length === 0 ? (
          <p className="text-sm text-ink-muted">{t('nodeUpdates.noNodes')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-ink-muted">
                  <th className="py-2 pr-3 font-medium">{t('nodeUpdates.node')}</th>
                  <th className="py-2 pr-3 font-medium">{t('nodeUpdates.pending')}</th>
                  <th className="py-2 pr-3 font-medium">{t('nodeUpdates.rebootColumn')}</th>
                  <th className="py-2 pr-3 font-medium">{t('nodeUpdates.checked')}</th>
                  <th className="py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {nodes.data.map((n) => (
                  <NodeRow
                    key={n.nodeId}
                    node={n}
                    open={open === n.nodeId}
                    onToggle={() => setOpen(open === n.nodeId ? null : n.nodeId)}
                    onRun={
                      canExecute && n.canApply && n.online && !n.activeJobId
                        ? () => {
                            setRunning(n);
                            setStarted(null);
                          }
                        : null
                    }
                    checked={n.checkedAt ? format.dateTime(new Date(n.checkedAt), 'medium') : '—'}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function NodeRow({
  node,
  open,
  onToggle,
  onRun,
  checked,
}: {
  node: NodeUpdatesSummary;
  open: boolean;
  onToggle: () => void;
  onRun: (() => void) | null;
  checked: string;
}) {
  const t = useTranslations();
  return (
    <>
      <tr className="border-t border-line align-top">
        <td className="py-2 pr-3">
          <div className="font-medium text-ink">{node.node}</div>
          <div className="text-xs text-ink-muted">
            {node.clusterName} · {node.tenantName}
            {!node.online && ` · ${t('nodeUpdates.offline')}`}
          </div>
        </td>
        <td className="py-2 pr-3">
          {node.total === 0 ? (
            <StatusBadge tone="ok">{t('nodeUpdates.upToDate')}</StatusBadge>
          ) : (
            <span className="flex flex-wrap gap-1">
              <StatusBadge tone="neutral">
                {t('nodeUpdates.count', { count: node.total })}
              </StatusBadge>
              {node.security > 0 && (
                <StatusBadge tone="error">
                  {t('nodeUpdates.security', { count: node.security })}
                </StatusBadge>
              )}
              {node.kernel > 0 && (
                <StatusBadge tone="warn">
                  {t('nodeUpdates.kernel', { count: node.kernel })}
                </StatusBadge>
              )}
              {node.proxmox > 0 && (
                <StatusBadge tone="neutral">
                  {t('nodeUpdates.proxmox', { count: node.proxmox })}
                </StatusBadge>
              )}
            </span>
          )}
        </td>
        <td className="py-2 pr-3">
          {node.rebootRequired ? (
            <span title={node.rebootReason ?? undefined}>
              <StatusBadge tone="warn">{t('nodeUpdates.rebootRequired')}</StatusBadge>
            </span>
          ) : (
            <span className="text-ink-muted">—</span>
          )}
        </td>
        <td className="py-2 pr-3 text-ink-muted">{checked}</td>
        <td className="py-2 text-right whitespace-nowrap">
          {node.activeJobId && (
            <Link href={`/jobs/${node.activeJobId}`} className="mr-2 text-xs text-accent underline">
              {t('nodeUpdates.inProgress')}
            </Link>
          )}
          {node.total > 0 && (
            <Button variant="quiet" onClick={onToggle}>
              {open ? t('nodeUpdates.hidePackages') : t('nodeUpdates.showPackages')}
            </Button>
          )}
          {onRun && (
            <Button variant="secondary" onClick={onRun}>
              {t('nodeUpdates.update')}
            </Button>
          )}
          {!node.canApply && (
            <span className="block text-xs text-ink-muted">{t('nodeUpdates.needsSsh')}</span>
          )}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5} className="pb-3">
            <Packages nodeId={node.nodeId} />
            {node.rebootRequired && node.rebootReason && (
              <p className="mt-2 text-xs text-ink-muted">{node.rebootReason}</p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function Packages({ nodeId }: { nodeId: string }) {
  const t = useTranslations();
  const list = useApiResource<PendingPackage[]>(`/updates/nodes/${nodeId}/packages`);
  if (list.state !== 'ready')
    return <p className="text-xs text-ink-muted">{t('common.loading')}</p>;
  return (
    <table className="w-full rounded border border-line text-xs">
      <tbody>
        {list.data.map((p) => (
          <tr key={p.package} className="border-t border-line first:border-t-0">
            <td className="px-2 py-1 font-mono text-ink">{p.package}</td>
            <td className="px-2 py-1 text-ink-muted">
              {p.currentVersion ?? t('nodeUpdates.new')} → {p.candidateVersion}
            </td>
            <td className="px-2 py-1">
              {p.isSecurity && (
                <StatusBadge tone="error">{t('nodeUpdates.securityShort')}</StatusBadge>
              )}{' '}
              {p.isKernel && <StatusBadge tone="warn">{t('nodeUpdates.kernelShort')}</StatusBadge>}{' '}
              {p.isProxmox && <StatusBadge tone="neutral">Proxmox</StatusBadge>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

function PoliciesTab({ clusters, canManage }: { clusters: ClusterSummary[]; canManage: boolean }) {
  const t = useTranslations();
  const describeError = useApiError();
  const policies = useApiResource<UpdatePolicySummary[]>('/updates/policies');
  const windows = useApiResource<MaintenanceWindowSummary[]>('/updates/windows');
  const [editing, setEditing] = useState<Partial<UpdatePolicySummary> | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);

  const cluster = clusters.find((c) => c.id === editing?.clusterId);
  const windowChoices =
    windows.state === 'ready' ? windows.data.filter((w) => w.tenantId === cluster?.tenantId) : [];

  async function save() {
    if (!editing) return;
    setFailure(null);
    const result = await apiPut('/updates/policies', {
      clusterId: editing.clusterId,
      name: editing.name ?? '',
      enabled: editing.enabled ?? true,
      autoApply: editing.autoApply ?? false,
      requireApproval: editing.requireApproval ?? false,
      rebootPolicy: editing.rebootPolicy ?? 'IF_REQUIRED',
      maintenanceWindowId: editing.maintenanceWindowId || null,
    });
    if (!result.ok) return setFailure(result.error);
    setEditing(null);
    policies.reload();
  }

  async function remove(id: string) {
    setFailure(null);
    const result = await apiDelete(`/updates/policies/${id}`);
    if (!result.ok) return setFailure(result.error);
    policies.reload();
  }

  return (
    <div className="space-y-4">
      {failure && <FormError>{describeError(failure)}</FormError>}
      {canManage && !editing && (
        <Button onClick={() => setEditing({ enabled: true, rebootPolicy: 'IF_REQUIRED' })}>
          {t('nodeUpdates.newPolicy')}
        </Button>
      )}
      {editing && (
        <Card title={t('nodeUpdates.policyTitle')} description={t('nodeUpdates.policyBody')}>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label={t('nodeUpdates.cluster')}>
              {(props) => (
                <select
                  {...props}
                  className={select}
                  value={editing.clusterId ?? ''}
                  onChange={(e) =>
                    setEditing({ ...editing, clusterId: e.target.value, maintenanceWindowId: null })
                  }
                >
                  <option value="">{t('nodeUpdates.chooseCluster')}</option>
                  {clusters.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} — {c.tenantName}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label={t('nodeUpdates.policyName')}>
              {(props) => (
                <TextInput
                  {...props}
                  value={editing.name ?? ''}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                />
              )}
            </Field>
            <Field label={t('nodeUpdates.reboot')}>
              {(props) => (
                <select
                  {...props}
                  className={select}
                  value={editing.rebootPolicy ?? 'IF_REQUIRED'}
                  onChange={(e) =>
                    setEditing({ ...editing, rebootPolicy: e.target.value as RebootPolicy })
                  }
                >
                  {REBOOT_POLICIES.map((p) => (
                    <option key={p} value={p}>
                      {t(`nodeUpdates.rebootPolicy.${p}`)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label={t('nodeUpdates.window')} hint={t('nodeUpdates.windowHint')}>
              {(props) => (
                <select
                  {...props}
                  className={select}
                  value={editing.maintenanceWindowId ?? ''}
                  onChange={(e) =>
                    setEditing({ ...editing, maintenanceWindowId: e.target.value || null })
                  }
                >
                  <option value="">{t('nodeUpdates.noWindow')}</option>
                  {windowChoices.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <div className="space-y-2 md:col-span-2">
              {(['enabled', 'requireApproval', 'autoApply'] as const).map((key) => (
                <label key={key} className="flex items-start gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={Boolean(editing[key] ?? key === 'enabled')}
                    onChange={(e) => setEditing({ ...editing, [key]: e.target.checked })}
                  />
                  <span>
                    {t(`nodeUpdates.${key}`)}
                    <span className="block text-xs text-ink-muted">
                      {t(`nodeUpdates.${key}Hint`)}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            <div className="flex gap-2 md:col-span-2">
              <Button onClick={() => void save()} disabled={!editing.clusterId || !editing.name}>
                {t('nodeUpdates.save')}
              </Button>
              <Button variant="secondary" onClick={() => setEditing(null)}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        </Card>
      )}
      <Card title={t('nodeUpdates.policiesTitle')} description={t('nodeUpdates.policiesBody')}>
        {policies.state !== 'ready' ? (
          <p className="text-sm text-ink-muted">{t('common.loading')}</p>
        ) : policies.data.length === 0 ? (
          <p className="text-sm text-ink-muted">{t('nodeUpdates.noPolicies')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {policies.data.map((p) => (
              <li
                key={p.id}
                className="flex flex-wrap items-start justify-between gap-2 py-2 text-sm"
              >
                <span>
                  <span className="font-medium text-ink">{p.name}</span> — {p.clusterName}
                  <span className="block text-xs text-ink-muted">
                    {[
                      p.enabled ? null : t('nodeUpdates.disabled'),
                      p.autoApply ? t('nodeUpdates.autoApply') : null,
                      p.requireApproval ? t('nodeUpdates.requireApproval') : null,
                      t(`nodeUpdates.rebootPolicy.${p.rebootPolicy}`),
                      p.windowName
                        ? t('nodeUpdates.inWindow', { window: p.windowName })
                        : t('nodeUpdates.anyTime'),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                {canManage && (
                  <span className="flex gap-1">
                    <Button variant="quiet" onClick={() => setEditing(p)}>
                      {t('nodeUpdates.edit')}
                    </Button>
                    <Button variant="quiet" onClick={() => void remove(p.id)}>
                      {t('nodeUpdates.remove')}
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

interface WindowDraft {
  id?: string;
  tenantId: string;
  name: string;
  timezone: string;
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  days: string[];
  monthDay: string;
  time: string;
  durationMinutes: number;
  rrule: string;
  advanced: boolean;
  blackoutDates: string;
}

function ruleFrom(d: WindowDraft): string {
  if (d.advanced) return d.rrule;
  const [hour, minute] = d.time.split(':').map(Number);
  const parts = [`FREQ=${d.freq}`];
  if (d.freq === 'WEEKLY' && d.days.length) parts.push(`BYDAY=${d.days.join(',')}`);
  if (d.freq === 'MONTHLY')
    parts.push(d.monthDay.match(/^-?\d+$/) ? `BYMONTHDAY=${d.monthDay}` : `BYDAY=${d.monthDay}`);
  parts.push(`BYHOUR=${hour ?? 0}`, `BYMINUTE=${minute ?? 0}`);
  return parts.join(';');
}

function WindowsTab({ tenants, canManage }: { tenants: TenantSummary[]; canManage: boolean }) {
  const t = useTranslations();
  const format = useFormatter();
  const describeError = useApiError();
  const windows = useApiResource<MaintenanceWindowSummary[]>('/updates/windows');
  const [draft, setDraft] = useState<WindowDraft | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [zone, setZone] = useState('UTC');
  useEffect(() => setZone(Intl.DateTimeFormat().resolvedOptions().timeZone), []);

  const rule = draft ? ruleFrom(draft) : '';
  const problem = draft ? ruleProblem(rule) : null;
  const preview =
    draft && !problem
      ? (() => {
          try {
            return windowState(
              { rrule: rule, timezone: draft.timezone, durationMinutes: draft.durationMinutes },
              Date.now(),
            );
          } catch {
            return null;
          }
        })()
      : null;

  async function save() {
    if (!draft) return;
    setFailure(null);
    const body = {
      tenantId: draft.tenantId,
      name: draft.name,
      timezone: draft.timezone,
      rrule: rule,
      durationMinutes: draft.durationMinutes,
      blackoutDates: draft.blackoutDates
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    };
    const result = draft.id
      ? await apiPut(`/updates/windows/${draft.id}`, body)
      : await apiPost('/updates/windows', body);
    if (!result.ok) return setFailure(result.error);
    setDraft(null);
    windows.reload();
  }

  async function remove(id: string) {
    setFailure(null);
    const result = await apiDelete(`/updates/windows/${id}`);
    if (!result.ok) return setFailure(result.error);
    windows.reload();
  }

  const blank = (): WindowDraft => ({
    tenantId: tenants.find((x) => x.kind !== 'MSP_ROOT')?.id ?? tenants[0]?.id ?? '',
    name: '',
    timezone: zone,
    freq: 'WEEKLY',
    days: ['SU'],
    monthDay: '-1SA',
    time: '02:00',
    durationMinutes: 180,
    rrule: '',
    advanced: false,
    blackoutDates: '',
  });

  return (
    <div className="space-y-4">
      {failure && <FormError>{describeError(failure)}</FormError>}
      {canManage && !draft && (
        <Button onClick={() => setDraft(blank())}>{t('nodeUpdates.newWindow')}</Button>
      )}
      {draft && (
        <Card title={t('nodeUpdates.windowTitle')} description={t('nodeUpdates.windowBody')}>
          <div className="grid gap-3 md:grid-cols-2">
            {!draft.id && (
              <Field label={t('nodeUpdates.tenant')}>
                {(props) => (
                  <select
                    {...props}
                    className={select}
                    value={draft.tenantId}
                    onChange={(e) => setDraft({ ...draft, tenantId: e.target.value })}
                  >
                    {tenants
                      .filter((x) => x.status === 'ACTIVE')
                      .map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                        </option>
                      ))}
                  </select>
                )}
              </Field>
            )}
            <Field label={t('nodeUpdates.windowName')}>
              {(props) => (
                <TextInput
                  {...props}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              )}
            </Field>
            <Field label={t('nodeUpdates.timezone')}>
              {(props) => (
                <TextInput
                  {...props}
                  value={draft.timezone}
                  onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}
                />
              )}
            </Field>
            <Field label={t('nodeUpdates.duration')}>
              {(props) => (
                <TextInput
                  {...props}
                  type="number"
                  min={15}
                  max={1440}
                  value={draft.durationMinutes}
                  onChange={(e) => setDraft({ ...draft, durationMinutes: Number(e.target.value) })}
                />
              )}
            </Field>
            {!draft.advanced && (
              <>
                <Field label={t('nodeUpdates.frequency')}>
                  {(props) => (
                    <select
                      {...props}
                      className={select}
                      value={draft.freq}
                      onChange={(e) =>
                        setDraft({ ...draft, freq: e.target.value as WindowDraft['freq'] })
                      }
                    >
                      {(['DAILY', 'WEEKLY', 'MONTHLY'] as const).map((f) => (
                        <option key={f} value={f}>
                          {t(`nodeUpdates.freq.${f}`)}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                <Field label={t('nodeUpdates.startTime')}>
                  {(props) => (
                    <TextInput
                      {...props}
                      type="time"
                      value={draft.time}
                      onChange={(e) => setDraft({ ...draft, time: e.target.value })}
                    />
                  )}
                </Field>
                {draft.freq === 'WEEKLY' && (
                  <div className="flex flex-wrap gap-2 md:col-span-2">
                    {WEEKDAYS.map((day) => (
                      <label key={day} className="flex items-center gap-1 text-sm text-ink">
                        <input
                          type="checkbox"
                          checked={draft.days.includes(day)}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              days: e.target.checked
                                ? [...draft.days, day]
                                : draft.days.filter((x) => x !== day),
                            })
                          }
                        />
                        {t(`nodeUpdates.day.${day}`)}
                      </label>
                    ))}
                  </div>
                )}
                {draft.freq === 'MONTHLY' && (
                  <Field label={t('nodeUpdates.monthDay')} hint={t('nodeUpdates.monthDayHint')}>
                    {(props) => (
                      <TextInput
                        {...props}
                        value={draft.monthDay}
                        onChange={(e) =>
                          setDraft({ ...draft, monthDay: e.target.value.toUpperCase() })
                        }
                      />
                    )}
                  </Field>
                )}
              </>
            )}
            {draft.advanced && (
              <div className="md:col-span-2">
                <Field label="RRULE" hint={t('nodeUpdates.rruleHint')}>
                  {(props) => (
                    <TextInput
                      {...props}
                      value={draft.rrule}
                      onChange={(e) => setDraft({ ...draft, rrule: e.target.value })}
                    />
                  )}
                </Field>
              </div>
            )}
            <Field label={t('nodeUpdates.blackout')} hint={t('nodeUpdates.blackoutHint')}>
              {(props) => (
                <TextInput
                  {...props}
                  value={draft.blackoutDates}
                  onChange={(e) => setDraft({ ...draft, blackoutDates: e.target.value })}
                />
              )}
            </Field>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={draft.advanced}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    advanced: e.target.checked,
                    rrule: e.target.checked ? ruleFrom(draft) : draft.rrule,
                  })
                }
              />
              {t('nodeUpdates.advancedRule')}
            </label>
            <p className="text-xs text-ink-muted md:col-span-2">
              <span className="font-mono">{rule}</span>
              {problem ? (
                <span className="block text-error">{problem}</span>
              ) : preview?.nextOpening ? (
                <span className="block">
                  {t('nodeUpdates.nextOpening', {
                    when: format.dateTime(new Date(preview.nextOpening), {
                      dateStyle: 'full',
                      timeStyle: 'short',
                    }),
                  })}
                </span>
              ) : null}
            </p>
            <div className="flex gap-2 md:col-span-2">
              <Button onClick={() => void save()} disabled={Boolean(problem) || !draft.name}>
                {t('nodeUpdates.save')}
              </Button>
              <Button variant="secondary" onClick={() => setDraft(null)}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        </Card>
      )}
      <Card title={t('nodeUpdates.windowsTitle')} description={t('nodeUpdates.windowsBody')}>
        {windows.state !== 'ready' ? (
          <p className="text-sm text-ink-muted">{t('common.loading')}</p>
        ) : windows.data.length === 0 ? (
          <p className="text-sm text-ink-muted">{t('nodeUpdates.noWindows')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {windows.data.map((w) => (
              <li
                key={w.id}
                className="flex flex-wrap items-start justify-between gap-2 py-2 text-sm"
              >
                <span>
                  <span className="font-medium text-ink">{w.name}</span> — {w.tenantName}{' '}
                  {w.open && <StatusBadge tone="ok">{t('nodeUpdates.openNow')}</StatusBadge>}
                  <span className="block font-mono text-xs text-ink-muted">
                    {w.rrule} · {w.timezone} ·{' '}
                    {t('nodeUpdates.minutes', { minutes: w.durationMinutes })}
                  </span>
                  <span className="block text-xs text-ink-muted">
                    {w.open && w.closesAt
                      ? t('nodeUpdates.closesAt', {
                          when: format.dateTime(new Date(w.closesAt), 'medium'),
                        })
                      : w.nextOpening
                        ? t('nodeUpdates.nextOpening', {
                            when: format.dateTime(new Date(w.nextOpening), 'medium'),
                          })
                        : t('nodeUpdates.neverOpens')}
                  </span>
                </span>
                {canManage && (
                  <span className="flex gap-1">
                    <Button
                      variant="quiet"
                      onClick={() =>
                        setDraft({
                          ...blank(),
                          id: w.id,
                          tenantId: w.tenantId,
                          name: w.name,
                          timezone: w.timezone,
                          durationMinutes: w.durationMinutes,
                          rrule: w.rrule,
                          advanced: true,
                          blackoutDates: w.blackoutDates.join(', '),
                        })
                      }
                    >
                      {t('nodeUpdates.edit')}
                    </Button>
                    <Button variant="quiet" onClick={() => void remove(w.id)}>
                      {t('nodeUpdates.remove')}
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function HistoryTab() {
  const t = useTranslations();
  const format = useFormatter();
  const jobs = useApiResource<{ jobs: JobSummary[] }>('/jobs?type=node.update&limit=100');
  const nodes = useApiResource<NodeUpdatesSummary[]>('/updates/nodes');
  const nameOf = (ids: string[]) => {
    const found = nodes.state === 'ready' ? nodes.data.find((n) => ids.includes(n.nodeId)) : null;
    return found ? `${found.node} (${found.clusterName})` : t('nodeUpdates.aNode');
  };
  return (
    <Card title={t('nodeUpdates.historyTitle')} description={t('nodeUpdates.historyBody')}>
      {jobs.state !== 'ready' ? (
        <p className="text-sm text-ink-muted">{t('common.loading')}</p>
      ) : jobs.data.jobs.length === 0 ? (
        <p className="text-sm text-ink-muted">{t('nodeUpdates.noHistory')}</p>
      ) : (
        <ul className="divide-y divide-line">
          {jobs.data.jobs.map((job) => (
            <li
              key={job.id}
              className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
            >
              <Link href={`/jobs/${job.id}`} className="text-accent underline">
                {nameOf(job.targetIds)}
              </Link>
              <span className="flex items-center gap-2 text-ink-muted">
                <JobStatusBadge status={job.status} />
                {format.dateTime(new Date(job.queuedAt), 'medium')}
                {' · '}
                {job.createdBy ? job.createdBy.email : t('nodeUpdates.byPolicy')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

'use client';

import { useMemo, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import clsx from 'clsx';
import { Card, Notice, StatusBadge } from '@/components/ui/primitives';
import type { AuditEventView, TenantSummary } from '@/lib/session-types';
import { useApiResource } from './use-api-resource';
import { SupportLogsCard } from './support-logs-card';
import { PanelError, PanelLoading } from './panel-state';

const TONE = {
  SUCCESS: 'ok',
  FAILURE: 'error',
  DENIED: 'warn',
} as const;

const PAGE_SIZE = 50;

/** A `yyyy-mm-dd` from a date field as the start of that day, here, in ISO. */
const startOfDay = (value: string): string => new Date(`${value}T00:00:00`).toISOString();
/** …and the start of the day after, so "until" includes the day chosen. */
const endOfDay = (value: string): string => {
  const date = new Date(`${value}T00:00:00`);
  date.setDate(date.getDate() + 1);
  return date.toISOString();
};

/**
 * The audit trail, inside Server management.
 *
 * Paged by cursor, because the table only grows: an offset page would shift
 * under the reader as events arrive, and page two would repeat rows from page
 * one during exactly the period worth reading about.
 *
 * Pages accumulate rather than replace. Reading an audit log means following a
 * sequence of events, and a "next page" that throws away what you just read
 * breaks the thing you came here to do.
 */
export function AuditPanel() {
  const t = useTranslations();
  const format = useFormatter();

  const [action, setAction] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [older, setOlder] = useState<AuditEventView[]>([]);
  const loadedOnce = useRef(false);

  // The filters, as the API takes them — shared by the list and the export.
  const filters = useMemo(() => {
    const params = new URLSearchParams();
    if (action) params.set('action', action);
    if (tenantId) params.set('tenantId', tenantId);
    if (from) params.set('from', startOfDay(from));
    if (to) params.set('to', endOfDay(to));
    return params;
  }, [action, tenantId, from, to]);

  const query = useMemo(() => {
    const params = new URLSearchParams(filters);
    params.set('limit', String(PAGE_SIZE));
    if (cursor) params.set('cursor', cursor);
    return `/audit-events?${params.toString()}`;
  }, [filters, cursor]);

  const page = useApiResource<{ events: AuditEventView[]; nextCursor: string | null }>(query);
  const actions = useApiResource<{ actions: string[] }>('/audit-events/actions');
  // The tenants this account reaches: one for a customer, all of them for the MSP.
  const tenants = useApiResource<{ tenants: TenantSummary[] }>('/tenants');
  const tenantList = tenants.data?.tenants ?? [];
  const msp = tenantList.find((tenant) => tenant.kind === 'MSP_ROOT');
  const shownTenant =
    tenantList.find((tenant) => tenant.id === tenantId) ??
    (tenantList.length === 1 ? tenantList[0] : undefined);
  const exportHref = (format: 'csv' | 'json') => {
    const params = new URLSearchParams(filters);
    params.set('format', format);
    return `/api/v1/audit-events/export?${params.toString()}`;
  };

  // Only the first load replaces the panel. After that the filters stay on
  // screen while a new selection loads, instead of blinking away and back.
  if (page.state === 'ready') loadedOnce.current = true;
  if (page.state === 'loading' && older.length === 0 && !loadedOnce.current)
    return <PanelLoading />;
  if (page.state === 'failed') return <PanelError error={page.error} />;

  const events = [...older, ...(page.data?.events ?? [])];
  // Which tenant a row belongs to matters only while more than one is shown.
  const showTenant = tenantList.length > 1 && !tenantId;
  const nextCursor = page.data?.nextCursor ?? null;

  function loadOlder() {
    if (!page.data || !nextCursor) return;
    setOlder(events);
    setCursor(nextCursor);
  }

  function changeFilter(apply: () => void) {
    apply();
    setOlder([]);
    setCursor(null);
  }
  const changeAction = (next: string) => changeFilter(() => setAction(next));

  return (
    <div className="space-y-5">
      <Notice tone="neutral" title={t('audit.appendOnlyTitle')}>
        {t('audit.appendOnlyBody')}{' '}
        {shownTenant
          ? shownTenant.auditRetentionDays === null
            ? t('audit.retentionForever', { tenant: shownTenant.name })
            : t('audit.retentionYears', {
                tenant: shownTenant.name,
                years: Math.round(shownTenant.auditRetentionDays / 365),
              })
          : msp && t('audit.retentionInstallation')}
      </Notice>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-ink-muted">
          {t('audit.columnAction')}
          <select
            value={action}
            onChange={(event) => changeAction(event.target.value)}
            className="h-8 min-w-56 rounded border border-line bg-surface px-2 text-sm text-ink shadow-card"
          >
            <option value="">{t('server.audit.allActions')}</option>
            {(actions.data?.actions ?? []).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>

        {tenantList.length > 1 && (
          <label className="flex flex-col gap-1 text-xs text-ink-muted">
            {t('audit.filterTenant')}
            <select
              value={tenantId}
              onChange={(event) => changeFilter(() => setTenantId(event.target.value))}
              className="h-8 min-w-44 rounded border border-line bg-surface px-2 text-sm text-ink shadow-card"
            >
              <option value="">{t('audit.filterAllTenants')}</option>
              {tenantList.map((tenant) => (
                <option key={tenant.id} value={tenant.id}>
                  {tenant.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="flex flex-col gap-1 text-xs text-ink-muted">
          {t('audit.filterFrom')}
          <input
            type="date"
            value={from}
            max={to || undefined}
            onChange={(event) => changeFilter(() => setFrom(event.target.value))}
            className="h-8 rounded border border-line bg-surface px-2 text-sm text-ink shadow-card"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-muted">
          {t('audit.filterTo')}
          <input
            type="date"
            value={to}
            min={from || undefined}
            onChange={(event) => changeFilter(() => setTo(event.target.value))}
            className="h-8 rounded border border-line bg-surface px-2 text-sm text-ink shadow-card"
          />
        </label>

        <p className="ml-auto text-xs text-ink-muted">
          {t('server.audit.loadedCount', { count: events.length })}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
        <span className="font-medium text-ink">{t('audit.export')}</span>
        <a
          href={exportHref('csv')}
          download
          className="rounded border border-line bg-surface px-2.5 py-1 text-ink shadow-card hover:border-line-strong"
        >
          {t('audit.exportCsv')}
        </a>
        <a
          href={exportHref('json')}
          download
          className="rounded border border-line bg-surface px-2.5 py-1 text-ink shadow-card hover:border-line-strong"
        >
          {t('audit.exportJson')}
        </a>
        <span>{t('audit.exportHint')}</span>
      </div>

      <SupportLogsCard filters={filters} />

      <Card title={t('audit.recent')} bodyClassName="p-0">
        {events.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-ink-muted">
            {page.state === 'loading' ? t('common.loading') : t('audit.empty')}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface-2/80 text-left text-xs text-ink-muted backdrop-blur">
                <tr>
                  <th className="px-4 py-2 font-medium">{t('audit.columnWhen')}</th>
                  {showTenant && (
                    <th className="px-4 py-2 font-medium">{t('audit.columnTenant')}</th>
                  )}
                  <th className="px-4 py-2 font-medium">{t('audit.columnAction')}</th>
                  <th className="px-4 py-2 font-medium">{t('audit.columnActor')}</th>
                  <th className="px-4 py-2 font-medium">{t('audit.columnResult')}</th>
                  <th className="px-4 py-2 font-medium">{t('audit.columnDetail')}</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <Row key={event.id} event={event} format={format} showTenant={showTenant} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {nextCursor && (
        <button
          type="button"
          onClick={loadOlder}
          disabled={page.state === 'loading'}
          className={clsx(
            'w-full rounded-md border border-line bg-surface px-4 py-2.5 text-sm text-ink-muted shadow-card',
            'transition-colors hover:border-line-strong hover:text-ink disabled:opacity-60',
          )}
        >
          {page.state === 'loading' ? t('common.loading') : t('audit.older')}
        </button>
      )}
    </div>
  );
}

function Row({
  event,
  format,
  showTenant,
}: {
  event: AuditEventView;
  format: ReturnType<typeof useFormatter>;
  showTenant: boolean;
}) {
  /*
   * Metadata is a free-shaped JSON object, so values can be nested. `String()`
   * on one of those renders "[object Object]", which tells the reader nothing —
   * and the nested values here are things like the scope a permission was
   * checked against, which is exactly what someone reading a denial wants.
   */
  const describe = (value: unknown): string => {
    if (value === null || value === undefined) return '—';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  };

  const metadata =
    event.metadata && typeof event.metadata === 'object'
      ? Object.entries(event.metadata as Record<string, unknown>)
          .map(([key, value]) => `${key}=${describe(value)}`)
          .join('  ')
      : '';

  return (
    <tr className="border-t border-line align-top">
      <td className="whitespace-nowrap px-4 py-2 text-xs text-ink-muted">
        {format.dateTime(new Date(event.at), { dateStyle: 'short', timeStyle: 'medium' })}
      </td>
      {showTenant && (
        <td className="px-4 py-2 text-xs text-ink-muted">{event.tenantName ?? '—'}</td>
      )}
      <td className="px-4 py-2 font-mono text-xs text-ink">{event.action}</td>
      <td className="px-4 py-2 text-xs text-ink-muted">{event.actorLabel ?? event.actorType}</td>
      <td className="px-4 py-2">
        <StatusBadge tone={TONE[event.result]}>{event.result}</StatusBadge>
      </td>
      <td className="px-4 py-2 text-xs text-ink-muted">
        {event.resourceLabel && <span className="text-ink">{event.resourceLabel}</span>}
        {metadata && <span className="ml-2 break-all font-mono">{metadata}</span>}
        {!event.resourceLabel && !metadata && '—'}
      </td>
    </tr>
  );
}

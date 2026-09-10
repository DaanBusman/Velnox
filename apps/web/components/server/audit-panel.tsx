'use client';

import { useMemo, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import clsx from 'clsx';
import { Card, Notice, StatusBadge } from '@/components/ui/primitives';
import type { AuditEventView } from '@/lib/session-types';
import { useApiResource } from './use-api-resource';
import { PanelError, PanelLoading } from './panel-state';

const TONE = {
  SUCCESS: 'ok',
  FAILURE: 'error',
  DENIED: 'warn',
} as const;

const PAGE_SIZE = 50;

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
  const [cursor, setCursor] = useState<string | null>(null);
  const [older, setOlder] = useState<AuditEventView[]>([]);

  const query = useMemo(() => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (action) params.set('action', action);
    if (cursor) params.set('cursor', cursor);
    return `/audit-events?${params.toString()}`;
  }, [action, cursor]);

  const page = useApiResource<{ events: AuditEventView[]; nextCursor: string | null }>(query);
  const actions = useApiResource<{ actions: string[] }>('/audit-events/actions');

  if (page.state === 'loading' && older.length === 0) return <PanelLoading />;
  if (page.state === 'failed') return <PanelError error={page.error} />;

  const events = [...older, ...(page.data?.events ?? [])];
  const nextCursor = page.data?.nextCursor ?? null;

  function loadOlder() {
    if (!page.data || !nextCursor) return;
    setOlder(events);
    setCursor(nextCursor);
  }

  function changeAction(next: string) {
    setAction(next);
    setOlder([]);
    setCursor(null);
  }

  return (
    <div className="space-y-5">
      <Notice tone="neutral" title={t('audit.appendOnlyTitle')}>
        {t('audit.appendOnlyBody')}
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

        <p className="ml-auto text-xs text-ink-muted">
          {t('server.audit.loadedCount', { count: events.length })}
        </p>
      </div>

      <Card title={t('audit.recent')} bodyClassName="p-0">
        {events.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-ink-muted">{t('audit.empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface-2/80 text-left text-xs text-ink-muted backdrop-blur">
                <tr>
                  <th className="px-4 py-2 font-medium">{t('audit.columnWhen')}</th>
                  <th className="px-4 py-2 font-medium">{t('audit.columnAction')}</th>
                  <th className="px-4 py-2 font-medium">{t('audit.columnActor')}</th>
                  <th className="px-4 py-2 font-medium">{t('audit.columnResult')}</th>
                  <th className="px-4 py-2 font-medium">{t('audit.columnDetail')}</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <Row key={event.id} event={event} format={format} />
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
}: {
  event: AuditEventView;
  format: ReturnType<typeof useFormatter>;
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

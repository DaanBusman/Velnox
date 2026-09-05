import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Card, Notice, PageHeader, StatusBadge } from '@/components/ui/primitives';
import { listAuditEvents } from '@/lib/session';
import type { AuditEventView } from '@/lib/session-types';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('nav.auditLog') };
}

const TONE = {
  SUCCESS: 'ok',
  FAILURE: 'error',
  DENIED: 'warn',
} as const;

/**
 * The audit trail.
 *
 * Paged by cursor, because the table only grows: an offset page would shift
 * under the reader as events arrive, and page two would repeat rows from page
 * one during exactly the period worth reading about.
 */
export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string; action?: string }>;
}) {
  const { cursor, action } = await searchParams;

  const [t, format, result] = await Promise.all([
    getTranslations(),
    getFormatter(),
    listAuditEvents({ ...(cursor ? { cursor } : {}), ...(action ? { action } : {}) }),
  ]);

  if (!result.ok) {
    return (
      <>
        <PageHeader title={t('nav.auditLog')} />
        <Notice tone={result.code === 'authz.forbidden' ? 'warn' : 'error'}>
          {result.code === 'authz.forbidden'
            ? t('common.requiresPermission', { permission: 'audit.read' })
            : t('errors.generic')}
        </Notice>
      </>
    );
  }

  const { events, nextCursor } = result.data;
  const nextHref = nextCursor
    ? `/audit-log?${new URLSearchParams({ cursor: nextCursor, ...(action ? { action } : {}) })}`
    : null;

  return (
    <>
      <PageHeader title={t('nav.auditLog')} description={t('audit.subtitle')} />

      <div className="space-y-5">
        <Notice tone="neutral" title={t('audit.appendOnlyTitle')}>
          {t('audit.appendOnlyBody')}
        </Notice>

        <Card title={t('audit.recent')}>
          {events.length === 0 ? (
            <p className="text-sm text-ink-muted">{t('audit.empty')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-ink-muted">
                    <th className="py-2 pr-4 font-medium">{t('audit.columnWhen')}</th>
                    <th className="py-2 pr-4 font-medium">{t('audit.columnAction')}</th>
                    <th className="py-2 pr-4 font-medium">{t('audit.columnActor')}</th>
                    <th className="py-2 pr-4 font-medium">{t('audit.columnResult')}</th>
                    <th className="py-2 font-medium">{t('audit.columnDetail')}</th>
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

          {nextHref && (
            <div className="mt-3">
              <Link href={nextHref} className="text-xs text-ink-muted underline hover:text-ink">
                {t('audit.older')}
              </Link>
            </div>
          )}
          {cursor && (
            <div className="mt-1">
              <Link href="/audit-log" className="text-xs text-ink-muted underline hover:text-ink">
                {t('audit.newest')}
              </Link>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

function Row({
  event,
  format,
}: {
  event: AuditEventView;
  format: Awaited<ReturnType<typeof getFormatter>>;
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
    <tr className="border-b border-line align-top last:border-b-0">
      <td className="whitespace-nowrap py-2 pr-4 text-xs text-ink-muted">
        {format.dateTime(new Date(event.at), { dateStyle: 'short', timeStyle: 'medium' })}
      </td>
      <td className="py-2 pr-4 font-mono text-xs text-ink">{event.action}</td>
      <td className="py-2 pr-4 text-xs text-ink-muted">
        {event.actorLabel ?? event.actorType.toLowerCase()}
      </td>
      <td className="py-2 pr-4">
        <StatusBadge tone={TONE[event.result]}>{event.result.toLowerCase()}</StatusBadge>
      </td>
      <td className="py-2 font-mono text-xs text-ink-muted">
        {[event.resourceLabel, metadata].filter(Boolean).join('  ') || '—'}
      </td>
    </tr>
  );
}

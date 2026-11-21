import Link from 'next/link';
import type { ReactNode } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import type { ClusterCapacity, UpdateSplit } from '@/lib/dashboard';
import { StatusBadge, type StatusTone } from '@/components/ui/primitives';

/** One headline figure. Null is "no access" and a dash, never a zero. */
export function StatTile({
  label,
  value,
  detail,
  href,
}: {
  label: string;
  value: number | null;
  detail?: ReactNode;
  href: string;
}) {
  const t = useTranslations();
  const body = (
    <>
      <p className="truncate text-xs text-ink-muted">{label}</p>
      <p className={`mt-1 text-2xl font-semibold leading-none ${value === null ? 'text-ink-muted/60' : 'text-ink'}`}>
        {value ?? '—'}
      </p>
      <p className="mt-1.5 text-xs text-ink-muted">
        {value === null ? t('dashboard.tileNoAccess') : (detail ?? ' ')}
      </p>
    </>
  );
  const frame = 'block h-full rounded-md border border-line bg-surface px-3.5 py-3 shadow-card';
  return value === null ? (
    <div className={frame}>{body}</div>
  ) : (
    <Link href={href} className={`${frame} transition-colors hover:border-line-strong hover:bg-surface-2`}>
      {body}
    </Link>
  );
}

export interface AttentionItem {
  key: string;
  label: string;
  tone: StatusTone;
  /** What the badge says, so the row does not rely on its colour. */
  severity: string;
  count: number | string | null;
  href: string;
}

/** Only what is wrong or waiting, worst first. */
export function AttentionList({ items, partial }: { items: AttentionItem[]; partial: boolean }) {
  const t = useTranslations();
  return (
    <div className="space-y-3">
      {items.length === 0 ? (
        // Said only when everything could be read: a list that failed to load
        // must not look like a list with nothing on it.
        !partial && <p className="py-6 text-center text-sm text-ink-muted">{t('dashboard.attentionClear')}</p>
      ) : (
        <ul className="-my-1 divide-y divide-line">
          {items.map((item) => (
            <li key={item.key}>
              <Link
                href={item.href}
                className="flex items-center gap-2 rounded py-2 text-sm text-ink hover:bg-surface-2"
              >
                <StatusBadge tone={item.tone}>{item.severity}</StatusBadge>
                <span className="min-w-0 flex-1">{item.label}</span>
                {item.count !== null && (
                  <span className="font-semibold tabular-nums">{item.count}</span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {partial && <p className="text-xs text-ink-muted">{t('dashboard.attentionPartial')}</p>}
    </div>
  );
}

function Meter({ label, value }: { label: string; value: number | null }) {
  const percent = value === null ? null : Math.round(value * 100);
  const fill =
    value === null
      ? 'transparent'
      : value >= 0.9
        ? 'var(--velnox-chart-critical)'
        : value >= 0.75
          ? 'var(--velnox-chart-warning)'
          : 'var(--velnox-accent)';
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs">
        <span className="text-ink-muted">{label}</span>
        <span className="font-medium tabular-nums text-ink">
          {percent === null ? '—' : `${percent}%`}
        </span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-valuetext={percent === null ? '—' : `${percent}%`}
        className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3"
      >
        <div className="h-full rounded-full" style={{ width: `${percent ?? 0}%`, background: fill }} />
      </div>
    </div>
  );
}

/** How full each cluster is. The fullest come first, so a long list loses the calm ones. */
export function CapacityList({ rows, listed = 6 }: { rows: ClusterCapacity[]; listed?: number }) {
  const t = useTranslations();
  const format = useFormatter();
  if (rows.length === 0) {
    return <p className="py-6 text-center text-sm text-ink-muted">{t('dashboard.capacityEmpty')}</p>;
  }
  return (
    <div className="space-y-3">
      <ul className="divide-y divide-line">
        {rows.slice(0, listed).map((row) => (
          <li key={row.id} className="grid gap-x-5 gap-y-2 py-2.5 first:pt-0 md:grid-cols-[minmax(0,11rem)_1fr]">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <Link href={`/clusters/${row.id}`} className="truncate text-sm font-medium text-accent underline">
                {row.name}
              </Link>
              {row.stale && (
                <StatusBadge tone="warn">
                  {row.lastSeenAt
                    ? t('dashboard.capacityStale', {
                        when: format.dateTime(new Date(row.lastSeenAt), 'medium'),
                      })
                    : t('dashboard.capacityNever')}
                </StatusBadge>
              )}
            </div>
            <div className="grid grid-cols-3 gap-3 sm:gap-5">
              <Meter label={t('dashboard.capacityCpu')} value={row.cpu} />
              <Meter label={t('dashboard.capacityMemory')} value={row.memory} />
              <Meter label={t('dashboard.capacityStorage')} value={row.storage} />
            </div>
          </li>
        ))}
      </ul>
      {rows.length > listed && (
        <Link href="/clusters" className="text-xs text-accent underline">
          {t('dashboard.capacityAll', { count: rows.length })}
        </Link>
      )}
    </div>
  );
}

/** One whole, split in three, beside the figures: a thin bar and a list that names them. */
export function UpdateStatus({ split }: { split: UpdateSplit }) {
  const t = useTranslations();
  const total = split.current + split.pending + split.unknown;
  if (total === 0) {
    return <p className="py-6 text-center text-sm text-ink-muted">{t('dashboard.updatesEmpty')}</p>;
  }
  const parts = [
    { key: 'current', label: t('dashboard.updatesCurrent'), value: split.current, color: 'var(--velnox-chart-good)' },
    { key: 'pending', label: t('dashboard.updatesPending'), value: split.pending, color: 'var(--velnox-chart-warning)' },
    { key: 'unknown', label: t('dashboard.updatesUnknown'), value: split.unknown, color: 'var(--velnox-chart-neutral)' },
  ];
  return (
    <div className="space-y-3">
      <div
        role="img"
        aria-label={parts.map((part) => `${part.label}: ${part.value}`).join(', ')}
        className="flex h-2 gap-0.5"
      >
        {parts
          .filter((part) => part.value > 0)
          .map((part) => (
            <span
              key={part.key}
              className="rounded-full"
              style={{ flexGrow: part.value, flexBasis: 0, background: part.color }}
            />
          ))}
      </div>
      <ul className="space-y-1 text-sm">
        {parts.map((part) => (
          <li key={part.key} className="flex items-center gap-2 text-ink-muted">
            <span className="size-2.5 rounded-sm" style={{ background: part.color }} aria-hidden />
            <span className="min-w-0 flex-1 truncate">{part.label}</span>
            <span className="font-medium tabular-nums text-ink">{part.value}</span>
          </li>
        ))}
      </ul>
      {split.most.length > 0 && (
        <div className="border-t border-line pt-2.5">
          <p className="mb-1 text-xs font-medium text-ink-muted">{t('dashboard.updatesMost')}</p>
          <ul className="space-y-1 text-sm">
            {split.most.map((node) => (
              <li key={node.id} className="flex items-baseline justify-between gap-2">
                <Link href="/updates" className="min-w-0 truncate text-accent underline">
                  {node.name}
                  <span className="text-ink-muted"> ({node.clusterName})</span>
                </Link>
                <span className="shrink-0 text-xs tabular-nums text-ink-muted">
                  {t('dashboard.updatesPackages', { count: node.updatesAvailable ?? 0 })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

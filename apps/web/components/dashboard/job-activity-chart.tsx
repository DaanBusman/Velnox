'use client';

import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import type { JobActivityDay } from '@velnox/shared';
import { niceMax } from '@/lib/dashboard';

/** Bottom of the stack first. The colour means the outcome, on every chart. */
const SERIES = [
  { key: 'succeeded', label: 'status.job.succeeded', color: 'var(--velnox-chart-good)' },
  { key: 'partial', label: 'status.job.partially_succeeded', color: 'var(--velnox-chart-warning)' },
  { key: 'failed', label: 'status.job.failed', color: 'var(--velnox-chart-critical)' },
  { key: 'cancelled', label: 'status.job.cancelled', color: 'var(--velnox-chart-neutral)' },
] as const;

const totalOf = (day: JobActivityDay) => day.succeeded + day.partial + day.failed + day.cancelled;

/**
 * Finished jobs per day, stacked by how they ended.
 *
 * Plain elements rather than a chart library: a handful of columns, which then
 * follow the theme tokens and the page's width by themselves. Each column is a
 * button, so the same readout is there on keyboard focus and on a tap, and the
 * table below holds every value for whoever cannot use the chart.
 */
export function JobActivityChart({
  days,
  truncated,
}: {
  days: JobActivityDay[];
  truncated: boolean;
}) {
  const t = useTranslations();
  const format = useFormatter();
  const [active, setActive] = useState<number | null>(null);

  // A calendar date, so it is shown as written and never shifted by a time zone.
  const dateOf = (day: JobActivityDay) => new Date(`${day.date}T12:00:00Z`);
  const short = (day: JobActivityDay) =>
    format.dateTime(dateOf(day), { day: 'numeric', month: 'numeric', timeZone: 'UTC' });
  const long = (day: JobActivityDay) =>
    format.dateTime(dateOf(day), {
      weekday: 'short',
      day: 'numeric',
      month: 'long',
      timeZone: 'UTC',
    });

  const totals = SERIES.map((series) => days.reduce((sum, day) => sum + day[series.key], 0));
  const everything = totals.reduce((sum, value) => sum + value, 0);
  if (everything === 0) {
    return <p className="py-10 text-center text-sm text-ink-muted">{t('dashboard.activityEmpty')}</p>;
  }

  const top = niceMax(Math.max(...days.map(totalOf)));
  const ticks = [top, top / 2, 0];
  const shown = active === null ? null : days[active];

  return (
    <div className="space-y-3">
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
        {SERIES.map((series, index) => (
          <li key={series.key} className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ background: series.color }} aria-hidden />
            {t(series.label)}
            <span className="font-medium tabular-nums text-ink">{totals[index]}</span>
          </li>
        ))}
      </ul>

      <div className="relative h-44 pl-8">
        {ticks.map((tick) => (
          <div
            key={tick}
            className="absolute inset-x-0 flex items-center"
            style={{ bottom: `${(tick / top) * 100}%`, transform: 'translateY(50%)' }}
          >
            <span className="w-8 shrink-0 pr-2 text-right text-[10px] tabular-nums text-ink-muted">
              {tick}
            </span>
            <span className={`h-px flex-1 ${tick === 0 ? 'bg-line-strong' : 'bg-line'}`} />
          </div>
        ))}

        <div className="absolute inset-y-0 left-8 right-0 flex">
          {days.map((day, index) => {
            const total = totalOf(day);
            const parts = SERIES.filter((series) => day[series.key] > 0);
            return (
              <button
                key={day.date}
                type="button"
                className="flex h-full min-w-0 flex-1 items-end justify-center rounded-sm px-0.5 outline-none hover:bg-surface-2/60 focus-visible:ring-2 focus-visible:ring-accent"
                aria-label={`${long(day)}: ${
                  total === 0
                    ? '0'
                    : parts.map((series) => `${day[series.key]} ${t(series.label)}`).join(', ')
                }`}
                onMouseEnter={() => setActive(index)}
                onMouseLeave={() => setActive(null)}
                onFocus={() => setActive(index)}
                onBlur={() => setActive(null)}
              >
                {total > 0 && (
                  <span
                    className="flex w-full max-w-6 flex-col-reverse gap-0.5"
                    style={{ height: `${(total / top) * 100}%`, minHeight: 3 }}
                  >
                    {parts.map((series, part) => (
                      <span
                        key={series.key}
                        className={part === parts.length - 1 ? 'rounded-t' : ''}
                        style={{ background: series.color, flexGrow: day[series.key], minHeight: 2 }}
                      />
                    ))}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {shown && active !== null && (
          <div
            role="status"
            className="pointer-events-none absolute top-0 z-10 w-44 rounded-md border border-line bg-surface p-2.5 text-xs shadow-pop"
            style={
              // Kept inside the plot near either edge.
              active < days.length / 2
                ? { left: `calc(2rem + ${((active + 1) / days.length) * 100}% - ${(2 * (active + 1)) / days.length}rem + 4px)` }
                : { right: `calc(${((days.length - active) / days.length) * 100}% - ${(2 * (days.length - active)) / days.length}rem + 4px)` }
            }
          >
            <p className="mb-1.5 font-medium text-ink">{long(shown)}</p>
            <ul className="space-y-1">
              {SERIES.map((series) => (
                <li key={series.key} className="flex items-center gap-2 text-ink-muted">
                  <span className="h-0.5 w-3 rounded-full" style={{ background: series.color }} aria-hidden />
                  <span className="min-w-6 font-semibold tabular-nums text-ink">
                    {shown[series.key]}
                  </span>
                  {t(series.label)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="flex pl-8" aria-hidden>
        {days.map((day, index) => (
          <span
            key={day.date}
            className={`flex min-w-0 flex-1 justify-center whitespace-nowrap text-[10px] tabular-nums text-ink-muted ${
              (days.length - 1 - index) % 2 === 1 ? 'invisible xl:visible' : ''
            }`}
          >
            {short(day)}
          </span>
        ))}
      </div>

      {truncated && <p className="text-xs text-ink-muted">{t('dashboard.activityTruncated')}</p>}

      <details className="text-xs">
        <summary className="cursor-pointer text-ink-muted hover:text-ink">
          {t('dashboard.activityTable')}
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left">
            <thead className="text-ink-muted">
              <tr>
                <th className="py-1 pr-3 font-medium">{t('dashboard.activityDay')}</th>
                {SERIES.map((series) => (
                  <th key={series.key} className="py-1 pr-3 text-right font-medium">
                    {t(series.label)}
                  </th>
                ))}
                <th className="py-1 text-right font-medium">{t('dashboard.activityTotal')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line tabular-nums">
              {[...days].reverse().map((day) => (
                <tr key={day.date}>
                  <td className="whitespace-nowrap py-1 pr-3 text-ink">{long(day)}</td>
                  {SERIES.map((series) => (
                    <td key={series.key} className="py-1 pr-3 text-right text-ink">
                      {day[series.key]}
                    </td>
                  ))}
                  <td className="py-1 text-right font-medium text-ink">{totalOf(day)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

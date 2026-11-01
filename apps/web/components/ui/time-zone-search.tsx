'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import clsx from 'clsx';
import { searchTimeZones, timeIn, zoneLabel, type ZoneMatch } from '@/lib/time-zones';

export interface ZoneChoice {
  /** The zone, or null for "no zone of my own". */
  zone: string | null;
  label: string;
}

/**
 * A time zone, found by typing a place (0.7.17).
 *
 * Typing "Amsterdam" lists "Europe/Amsterdam 19:50": the zone, and the time it
 * is there now, so the right one is recognisable by its clock. Capitals named
 * differently from their zone and Dutch city names are found too (see
 * lib/time-zones.ts). With nothing typed it offers `suggestions` — the
 * installation default and the browser's own zone, say.
 *
 * A combobox in the ARIA sense: arrow keys move through the list, Enter picks,
 * Escape closes and puts back what was there.
 */
export function TimeZoneSearch({
  value,
  onChange,
  suggestions = [],
  disabled,
  id,
  className,
  ...aria
}: {
  value: string | null;
  onChange: (zone: string | null) => void;
  suggestions?: ZoneChoice[];
  disabled?: boolean;
  id?: string;
  className?: string;
  'aria-describedby'?: string | undefined;
  'aria-invalid'?: boolean | undefined;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const listId = useId();
  const [zones, setZones] = useState<string[]>([]);
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [now, setNow] = useState(() => new Date());

  // Known only in the browser: every zone it can name.
  useEffect(() => {
    const supported = (
      Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
    ).supportedValuesOf?.('timeZone');
    setZones(supported ?? []);
  }, []);
  // The clocks in the list move while it is open.
  useEffect(() => {
    if (!open) return;
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(timer);
  }, [open]);

  const options: (ZoneChoice & { place: string | null })[] = useMemo(() => {
    if (query && query.trim()) {
      return searchTimeZones(query, zones).map((match: ZoneMatch) => ({
        zone: match.zone,
        label: zoneLabel(match.zone),
        place: match.place,
      }));
    }
    return suggestions.map((choice) => ({ ...choice, place: null }));
  }, [query, zones, suggestions]);

  // No zone of its own reads as the suggestion that stands for that, if any.
  const shown =
    query ?? (value ? zoneLabel(value) : (suggestions.find((s) => s.zone === null)?.label ?? ''));

  function pick(choice: ZoneChoice) {
    setQuery(null);
    setOpen(false);
    onChange(choice.zone);
  }

  return (
    <div className={clsx('relative w-full max-w-xs', className)}>
      <input
        {...aria}
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        value={shown}
        placeholder={t('timeZone.placeholder')}
        onFocus={(event) => {
          event.target.select();
          setOpen(true);
          setActive(0);
        }}
        onBlur={() => {
          // After a click on an option has landed.
          setTimeout(() => {
            setOpen(false);
            setQuery(null);
          }, 150);
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
            setActive((index) => Math.min(index + 1, Math.max(options.length - 1, 0)));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive((index) => Math.max(index - 1, 0));
          } else if (event.key === 'Enter') {
            const choice = options[active];
            if (open && choice) {
              event.preventDefault();
              pick(choice);
            }
          } else if (event.key === 'Escape') {
            setOpen(false);
            setQuery(null);
          }
        }}
        className={clsx(
          'h-9 w-full rounded border border-line bg-surface px-2.5 text-sm text-ink',
          'shadow-[inset_0_1px_2px_rgb(13_18_25_/_0.05)] dark:shadow-[inset_0_1px_2px_rgb(0_0_0_/_0.35)]',
          'placeholder:text-ink-muted',
          'focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30',
          'disabled:cursor-not-allowed disabled:opacity-60',
        )}
      />
      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded border border-line bg-surface py-1 text-sm shadow-card"
        >
          {options.length === 0 ? (
            <li className="px-2.5 py-1.5 text-ink-muted">
              {query && query.trim() ? t('timeZone.none') : t('timeZone.typeToSearch')}
            </li>
          ) : (
            options.map((choice, index) => (
              <li
                key={`${choice.zone ?? 'default'}-${choice.place ?? ''}`}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => pick(choice)}
                className={clsx(
                  'flex cursor-pointer items-baseline justify-between gap-3 px-2.5 py-1.5',
                  index === active ? 'bg-surface-2 text-ink' : 'text-ink',
                )}
              >
                <span className="min-w-0 truncate">
                  {choice.label}
                  {choice.place && (
                    <span className="ml-1.5 text-xs text-ink-muted">{choice.place}</span>
                  )}
                </span>
                {choice.zone && (
                  <span className="shrink-0 font-mono text-xs tabular-nums text-ink-muted">
                    {timeIn(choice.zone, locale, now)}
                  </span>
                )}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

/**
 * Maintenance windows: when they open, evaluated in their own time zone.
 *
 * A window is an RFC 5545 recurrence rule for when it opens, a duration, and a
 * time zone. "Every Sunday at 02:00 Europe/Amsterdam" must open at 02:00 local
 * on the Sunday the clocks change as well, so occurrences are found as local
 * wall-clock times and only then turned into instants.
 *
 * **A subset, refused rather than guessed.** FREQ is DAILY, WEEKLY or MONTHLY;
 * BYDAY (with an ordinal for MONTHLY: `1SA`, `-1SU`), BYMONTHDAY, BYHOUR and
 * BYMINUTE narrow it. INTERVAL, COUNT, UNTIL and the rest are not supported and
 * a rule using them does not parse — a window that silently opened more often
 * than its author meant is the failure this file exists to prevent. Here and
 * not in the API, so the API, the worker's scheduler and the form agree.
 */

export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface ParsedRule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  /** Weekdays, with an ordinal for MONTHLY (`{ day: 'SU', nth: -1 }` is the last Sunday). */
  byDay: { day: Weekday; nth: number | null }[];
  byMonthDay: number[];
  byHour: number[];
  byMinute: number[];
}

export class RuleError extends Error {}

const list = (value: string): string[] =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

const integers = (value: string, min: number, max: number, name: string): number[] =>
  list(value).map((part) => {
    if (!/^-?\d{1,2}$/.test(part)) throw new RuleError(`${name} takes numbers`);
    const n = Number(part);
    if (n < min || n > max || n === 0) {
      if (!(n === 0 && min === 0)) throw new RuleError(`${name} is out of range`);
    }
    return n;
  });

export function parseRule(rule: string): ParsedRule {
  const text = rule.trim().replace(/^RRULE:/i, '');
  if (!text || text.length > 300) throw new RuleError('A rule is needed');
  const parts = new Map<string, string>();
  for (const pair of text.split(';')) {
    const [key, value] = pair.split('=');
    if (!key || value === undefined || value === '')
      throw new RuleError(`Not a rule part: ${pair}`);
    const name = key.trim().toUpperCase();
    if (parts.has(name)) throw new RuleError(`${name} appears twice`);
    parts.set(name, value.trim().toUpperCase());
  }
  for (const name of parts.keys()) {
    if (!['FREQ', 'BYDAY', 'BYMONTHDAY', 'BYHOUR', 'BYMINUTE'].includes(name)) {
      throw new RuleError(`${name} is not supported`);
    }
  }
  const freq = parts.get('FREQ');
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY') {
    throw new RuleError('FREQ is DAILY, WEEKLY or MONTHLY');
  }
  const byDay = list(parts.get('BYDAY') ?? '').map((part) => {
    const match = /^(-?[1-5])?(MO|TU|WE|TH|FR|SA|SU)$/.exec(part);
    if (!match) throw new RuleError(`BYDAY ${part} is not a weekday`);
    const nth = match[1] ? Number(match[1]) : null;
    if (nth !== null && freq !== 'MONTHLY')
      throw new RuleError('An ordinal day needs FREQ=MONTHLY');
    return { day: match[2] as Weekday, nth };
  });
  const byMonthDay = parts.has('BYMONTHDAY')
    ? integers(parts.get('BYMONTHDAY')!, -31, 31, 'BYMONTHDAY')
    : [];
  if (byMonthDay.length && freq !== 'MONTHLY') throw new RuleError('BYMONTHDAY needs FREQ=MONTHLY');
  if (byMonthDay.length && byDay.length) throw new RuleError('Use BYDAY or BYMONTHDAY, not both');
  if (freq === 'MONTHLY' && !byMonthDay.length && !byDay.length) {
    throw new RuleError('A monthly rule names its day');
  }
  const byHour = parts.has('BYHOUR') ? integers(parts.get('BYHOUR')!, 0, 23, 'BYHOUR') : [0];
  const byMinute = parts.has('BYMINUTE')
    ? integers(parts.get('BYMINUTE')!, 0, 59, 'BYMINUTE')
    : [0];
  if (byHour.some((h) => h < 0) || byMinute.some((m) => m < 0)) {
    throw new RuleError('Hours and minutes are not negative');
  }
  return { freq, byDay, byMonthDay, byHour, byMinute };
}

/** Whether a rule parses; the reason when it does not. */
export function ruleProblem(rule: string): string | null {
  try {
    parseRule(rule);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'Not a rule';
  }
}

// ---------------------------------------------------------------------------
// Time zones, without a library
// ---------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The wall-clock fields of an instant in a zone. */
export function zonedParts(
  instant: number,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number } {
  const values: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(instant))) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return {
    year: values.year!,
    month: values.month!,
    day: values.day!,
    hour: values.hour! % 24,
    minute: values.minute!,
  };
}

/** How far ahead of UTC a zone is at an instant, in milliseconds. */
function offsetAt(instant: number, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return asUtc - Math.floor(instant / 60_000) * 60_000;
}

/**
 * The instant a local wall-clock time happens. A time skipped by a clock going
 * forward happens at the first minute after the gap; a time that happens twice
 * when the clock goes back is the first of the two.
 */
export function zonedToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  // The zone's offset half a day either side: around a clock change these
  // differ, and each gives one candidate instant for this wall-clock time.
  const before = wall - offsetAt(wall - 12 * 60 * 60_000, timeZone);
  const after = wall - offsetAt(wall + 12 * 60 * 60_000, timeZone);
  const shows = (t: number) => {
    const p = zonedParts(t, timeZone);
    return (
      p.year === year &&
      p.month === month &&
      p.day === day &&
      p.hour === hour &&
      p.minute === minute
    );
  };
  const real = [before, after].filter(shows);
  // Twice (the clock went back): the first. Never (the clock went forward):
  // the moment after the gap, which the earlier offset lands on.
  return real.length ? Math.min(...real) : before;
}

// ---------------------------------------------------------------------------
// Occurrences and the window's state
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

function weekdayOf(year: number, month: number, day: number): Weekday {
  // Date.UTC's weekday for a calendar date is the date's own; 0 is Sunday.
  return WEEKDAYS[(new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7]!;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dateMatches(rule: ParsedRule, year: number, month: number, day: number): boolean {
  const weekday = weekdayOf(year, month, day);
  if (rule.freq === 'DAILY') return !rule.byDay.length || rule.byDay.some((d) => d.day === weekday);
  if (rule.freq === 'WEEKLY') {
    return rule.byDay.length ? rule.byDay.some((d) => d.day === weekday) : weekday === 'MO';
  }
  const length = daysInMonth(year, month);
  if (rule.byMonthDay.length) {
    return rule.byMonthDay.some((n) => (n > 0 ? n === day : length + n + 1 === day));
  }
  return rule.byDay.some((d) => {
    if (d.day !== weekday) return false;
    if (d.nth === null) return true;
    const fromStart = Math.floor((day - 1) / 7) + 1;
    const fromEnd = -(Math.floor((length - day) / 7) + 1);
    return d.nth === fromStart || d.nth === fromEnd;
  });
}

export interface WindowDefinition {
  rrule: string;
  timezone: string;
  durationMinutes: number;
  /** Local dates (`YYYY-MM-DD`) on which the window does not open. */
  blackoutDates?: string[];
}

/** Every opening between two instants, in order. */
export function openings(window: WindowDefinition, from: number, to: number): number[] {
  const rule = parseRule(window.rrule);
  const blackout = new Set(window.blackoutDates ?? []);
  const out: number[] = [];
  // Walk local calendar dates, a day either side for zone offsets.
  const start = zonedParts(from - DAY_MS, window.timezone);
  let cursor = Date.UTC(start.year, start.month - 1, start.day);
  const end = to + 2 * DAY_MS;
  while (cursor <= end) {
    const date = new Date(cursor);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (!blackout.has(iso) && dateMatches(rule, year, month, day)) {
      for (const hour of rule.byHour) {
        for (const minute of rule.byMinute) {
          const at = zonedToInstant(year, month, day, hour, minute, window.timezone);
          if (at >= from && at < to) out.push(at);
        }
      }
    }
    cursor += DAY_MS;
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

export interface WindowState {
  open: boolean;
  /** When the window that is open now opened, and when it closes. */
  openedAt: number | null;
  closesAt: number | null;
  /** The next opening after now; null when none in the coming 400 days. */
  nextOpening: number | null;
}

export function windowState(window: WindowDefinition, now: number): WindowState {
  const duration = window.durationMinutes * 60_000;
  const recent = openings(window, now - duration, now + 1);
  const openedAt = recent.length ? recent[recent.length - 1]! : null;
  const open = openedAt !== null && now < openedAt + duration;
  const next = openings(window, now + 1, now + 400 * DAY_MS)[0] ?? null;
  return {
    open,
    openedAt: open ? openedAt : null,
    closesAt: open && openedAt !== null ? openedAt + duration : null,
    nextOpening: next,
  };
}

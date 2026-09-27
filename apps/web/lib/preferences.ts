import 'server-only';
import { cookies } from 'next/headers';

/**
 * Per-viewer interface preferences.
 *
 * Cookies rather than rows, for the same reason the language is a cookie: these
 * decide how a screen behaves for one person in one browser, they carry no
 * authority, and putting them in the database would mean a write on every
 * change and a read on every page for something a browser already remembers.
 *
 * They are read on the server so a preference is honoured by the first render
 * rather than applied a frame later, which for the refresh interval is the
 * difference between "off" and "off after one refresh".
 */

export const REFRESH_COOKIE = 'velnox_refresh';

/**
 * How often the inventory screens re-read themselves, in seconds.
 *
 * A fixed set rather than a free number. The cost of this setting is paid by the
 * API on every tick, and a text field invites someone to type 1 — or 0.1, which
 * is the same request storm with a friendlier label. Zero is offered honestly as
 * "off", because an operator watching a long migration and an operator reading a
 * report want opposite things.
 */
export const REFRESH_CHOICES = [0, 2, 5, 10, 30, 60] as const;

export type RefreshSeconds = (typeof REFRESH_CHOICES)[number];

/** The cadence shipped before this was a setting, kept as the default. */
export const DEFAULT_REFRESH_SECONDS: RefreshSeconds = 2;

export function isRefreshSeconds(value: number): value is RefreshSeconds {
  return (REFRESH_CHOICES as readonly number[]).includes(value);
}

/**
 * Read the stored cadence, falling back to the default.
 *
 * Anything unrecognised is the default rather than an error: this arrives from a
 * browser, and a cookie someone has edited by hand should give them the shipped
 * behaviour, not a broken page.
 */
export async function refreshSeconds(): Promise<RefreshSeconds> {
  const raw = (await cookies()).get(REFRESH_COOKIE)?.value;
  if (raw === undefined) return DEFAULT_REFRESH_SECONDS;

  const parsed = Number(raw);
  return Number.isFinite(parsed) && isRefreshSeconds(parsed)
    ? parsed
    : DEFAULT_REFRESH_SECONDS;
}

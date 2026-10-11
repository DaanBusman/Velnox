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

/**
 * The time zone dates and times are shown in, for this viewer: an IANA name
 * such as `Europe/Amsterdam`. Absent means the installation's default
 * (VELNOX_DEFAULT_TIMEZONE). A display preference like the others — it changes
 * how a time is written, never which time it is.
 */
export const TIMEZONE_COOKIE = 'velnox_timezone';

/** A time zone this runtime knows. Anything else is ignored, never an error. */
export function isTimeZone(value: string | undefined | null): value is string {
  if (!value || value.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** The installation's default zone, which a viewer without a choice sees. */
export const installationTimeZone = (): string =>
  isTimeZone(process.env.VELNOX_DEFAULT_TIMEZONE)
    ? process.env.VELNOX_DEFAULT_TIMEZONE
    : 'Europe/Amsterdam';

/** The viewer's chosen zone, or null for the installation's default. */
export async function viewerTimeZone(): Promise<string | null> {
  const raw = (await cookies()).get(TIMEZONE_COOKIE)?.value;
  return isTimeZone(raw) ? raw : null;
}

/** Whether the signed-in screens move behind their content. Off by default. */
export const MOTION_BACKGROUND_COOKIE = 'velnox_motion_bg';

export async function motionBackground(): Promise<boolean> {
  return (await cookies()).get(MOTION_BACKGROUND_COOKIE)?.value === '1';
}

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

'use client';

/**
 * The viewer's "refresh screens automatically" interval, read in the browser.
 *
 * The same cookie `lib/preferences.ts` reads on the server, for the panels that
 * load their own data instead of being re-rendered by the page: Service status
 * and the running-jobs bar. A value that is not one of the offered choices is
 * the default, exactly as on the server.
 */
const COOKIE = 'velnox_refresh';
const CHOICES = [0, 2, 5, 10, 30, 60];
const DEFAULT_SECONDS = 2;

export function refreshSecondsInBrowser(): number {
  if (typeof document === 'undefined') return DEFAULT_SECONDS;
  const raw = document.cookie
    .split('; ')
    .find((part) => part.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  const parsed = Number(raw);
  return raw !== undefined && CHOICES.includes(parsed) ? parsed : DEFAULT_SECONDS;
}

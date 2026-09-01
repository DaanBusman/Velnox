/**
 * Locale resolution for Velnox.
 *
 * The message catalogues themselves are plain JSON under `locales/` and are
 * imported directly by the web app through the package's `exports` map, so a
 * translator edits a file that no build step has touched. This module owns only
 * the question "which locale applies to this request", which the API, the web
 * app and tests all have to answer identically.
 */

export const LOCALES = ['en', 'nl'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';
export const SOURCE_LOCALE: Locale = 'en';

export const LOCALE_COOKIE = 'velnox_locale';

export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  nl: 'Nederlands',
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/**
 * Parse an `Accept-Language` header into locale tags ordered by preference.
 * Region subtags are dropped (`nl-BE` matches `nl`); malformed entries are
 * skipped rather than throwing, because this input comes from the network.
 */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      if (!tag) return null;
      const qParam = params.find((p) => p.trim().startsWith('q='));
      const q = qParam ? Number.parseFloat(qParam.trim().slice(2)) : 1;
      if (!Number.isFinite(q) || q <= 0) return null;
      return { tag: tag.trim().toLowerCase(), q };
    })
    .filter((v): v is { tag: string; q: number } => v !== null)
    .sort((a, b) => b.q - a.q)
    .map((v) => v.tag);
}

export interface LocaleSources {
  /** An explicit choice stored on the user's account. Highest precedence. */
  userPreference?: string | null | undefined;
  /** The locale cookie set by the switcher. */
  cookie?: string | null | undefined;
  /** Raw `Accept-Language` header value. */
  acceptLanguage?: string | null | undefined;
  /** Installation default from configuration. */
  installationDefault?: string | null | undefined;
}

/**
 * Resolve the locale to use, in precedence order: the user's explicit choice,
 * then the cookie set by the switcher, then the browser's preference, then the
 * installation default, then the source locale.
 *
 * Always returns a supported locale — never `undefined`, so callers cannot
 * accidentally render an untranslated screen.
 */
export function resolveLocale(sources: LocaleSources): Locale {
  const { userPreference, cookie, acceptLanguage, installationDefault } = sources;

  if (isLocale(userPreference)) return userPreference;
  if (isLocale(cookie)) return cookie;

  for (const tag of parseAcceptLanguage(acceptLanguage)) {
    if (isLocale(tag)) return tag;
    const base = tag.split('-')[0];
    if (isLocale(base)) return base;
  }

  if (isLocale(installationDefault)) return installationDefault;
  return DEFAULT_LOCALE;
}

/** Relative path of a locale catalogue within this package. */
export const localeFile = (locale: Locale): string => `locales/${locale}.json`;

import { getRequestConfig } from 'next-intl/server';
import type { AbstractIntlMessages } from 'next-intl';
import { cookies, headers } from 'next/headers';
import { LOCALE_COOKIE, resolveLocale, type Locale } from '@velnox/i18n';
import en from '@velnox/i18n/locales/en.json';
import nl from '@velnox/i18n/locales/nl.json';

/**
 * Locale resolution for every server render.
 *
 * Catalogues are imported statically so the bundler can see them: a dynamic
 * import keyed on the locale would defeat tree-shaking and, worse, could fail at
 * runtime for a locale that exists on disk but was never bundled. CI already
 * guarantees the catalogues are complete and in step (scripts/validate-locales.mjs),
 * so a static map is safe.
 */
function withoutMetadata(catalogue: Record<string, unknown>): AbstractIntlMessages {
  const { $meta: _meta, ...messages } = catalogue;
  // Everything that survives is a string or a nested record of strings; the
  // shape is guaranteed by scripts/validate-locales.mjs, which fails the build
  // on any non-string leaf or missing key.
  return messages as AbstractIntlMessages;
}

const CATALOGUES: Record<Locale, AbstractIntlMessages> = {
  en: withoutMetadata(en as Record<string, unknown>),
  nl: withoutMetadata(nl as Record<string, unknown>),
};

export default getRequestConfig(async () => {
  const [cookieStore, headerList] = await Promise.all([cookies(), headers()]);

  const locale = resolveLocale({
    cookie: cookieStore.get(LOCALE_COOKIE)?.value,
    acceptLanguage: headerList.get('accept-language'),
    installationDefault: process.env.VELNOX_DEFAULT_LOCALE,
  });

  return {
    locale,
    messages: CATALOGUES[locale],
    timeZone: process.env.VELNOX_DEFAULT_TIMEZONE || 'Europe/Amsterdam',
  };
});

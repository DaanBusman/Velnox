'use client';

import { useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { LOCALES, LOCALE_LABELS, type Locale } from '@velnox/i18n';
import { setLocale } from '@/app/actions';

export function LocaleSwitcher({ current }: { current: string }) {
  const t = useTranslations();
  const [pending, startTransition] = useTransition();

  return (
    <label className="flex items-center gap-1.5">
      <span className="sr-only">{t('layout.language')}</span>
      <select
        value={current}
        disabled={pending}
        onChange={(event) => {
          const next = event.target.value;
          startTransition(async () => {
            await setLocale(next);
          });
        }}
        className="h-7 rounded border border-line bg-surface-2 px-1.5 text-xs text-ink disabled:opacity-60"
        aria-label={t('layout.language')}
      >
        {LOCALES.map((locale: Locale) => (
          <option key={locale} value={locale}>
            {LOCALE_LABELS[locale]}
          </option>
        ))}
      </select>
    </label>
  );
}

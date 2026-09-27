'use client';

import { useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { LOCALES, LOCALE_LABELS, type Locale } from '@velnox/i18n';
import { setLocale, setRefreshInterval } from '@/app/actions';
import { Card } from '@/components/ui/primitives';
import { Field } from '@/components/ui/form';

/**
 * The interface preferences: language, and how often screens re-read themselves.
 *
 * Both are per-viewer cookies rather than rows on the account. That is the
 * honest scope: they change what one person sees in one browser, they carry no
 * authority, and an engineer using a colleague's machine should not silently
 * change that colleague's screens.
 *
 * Saved on change rather than behind a Save button. There are two settings, both
 * reversible in one click, and a Save button on a form this small mostly creates
 * the state where someone changed a dropdown and walked away thinking it applied.
 */
export function InterfaceSettings({
  locale,
  refreshSeconds,
  refreshChoices,
}: {
  locale: string;
  refreshSeconds: number;
  refreshChoices: readonly number[];
}) {
  const t = useTranslations();
  const [pending, startTransition] = useTransition();

  const selectClass =
    'h-9 w-full max-w-xs rounded border border-line bg-surface px-2.5 text-sm text-ink disabled:opacity-60';

  return (
    <Card title={t('settings.interfaceTitle')} description={t('settings.interfaceBody')}>
      <div className="space-y-4">
        <Field label={t('layout.language')} hint={t('settings.languageHint')}>
          {(props) => (
            <select
              {...props}
              value={locale}
              disabled={pending}
              className={selectClass}
              onChange={(event) => {
                const next = event.target.value;
                startTransition(async () => {
                  await setLocale(next);
                });
              }}
            >
              {LOCALES.map((entry: Locale) => (
                <option key={entry} value={entry}>
                  {LOCALE_LABELS[entry]}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field label={t('settings.refreshLabel')} hint={t('settings.refreshHint')}>
          {(props) => (
            <select
              {...props}
              value={String(refreshSeconds)}
              disabled={pending}
              className={selectClass}
              onChange={(event) => {
                const next = Number(event.target.value);
                startTransition(async () => {
                  await setRefreshInterval(next);
                });
              }}
            >
              {refreshChoices.map((seconds) => (
                <option key={seconds} value={seconds}>
                  {seconds === 0
                    ? t('settings.refreshOff')
                    : t('settings.refreshEvery', { seconds })}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
    </Card>
  );
}

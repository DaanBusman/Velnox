'use client';

import { useEffect, useState, useTransition } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { LOCALES, LOCALE_LABELS, type Locale } from '@velnox/i18n';
import { setLocale, setMotionBackground, setRefreshInterval, setTimeZone } from '@/app/actions';
import { Card } from '@/components/ui/primitives';
import { Field } from '@/components/ui/form';

/**
 * The interface preferences: language, how often screens re-read themselves,
 * the time zone times are shown in, and the moving background.
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
  motionBackground,
  timeZone,
  installationTimeZone,
}: {
  locale: string;
  refreshSeconds: number;
  refreshChoices: readonly number[];
  motionBackground: boolean;
  /** The viewer's own zone, or null for the installation's. */
  timeZone: string | null;
  installationTimeZone: string;
}) {
  const t = useTranslations();
  const format = useFormatter();
  const [pending, startTransition] = useTransition();
  // Known only in the browser: its own zone and every zone it can name.
  const [browserZone, setBrowserZone] = useState<string | null>(null);
  const [zones, setZones] = useState<string[]>([]);
  useEffect(() => {
    setBrowserZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
    const supported = (
      Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
    ).supportedValuesOf?.('timeZone');
    setZones(supported ?? []);
  }, []);
  const shownZones = [...new Set([...(timeZone ? [timeZone] : []), ...zones])].sort((a, b) =>
    a.localeCompare(b),
  );

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

        <Field
          label={t('settings.timeZoneLabel')}
          hint={t('settings.timeZoneHint', {
            now: format.dateTime(new Date(), { dateStyle: 'medium', timeStyle: 'short' }),
          })}
        >
          {(props) => (
            <select
              {...props}
              value={timeZone ?? ''}
              disabled={pending}
              className={selectClass}
              onChange={(event) => {
                const next = event.target.value || null;
                startTransition(async () => {
                  await setTimeZone(next);
                });
              }}
            >
              <option value="">
                {t('settings.timeZoneDefault', { zone: installationTimeZone })}
              </option>
              {browserZone && browserZone !== timeZone && (
                <option value={browserZone}>
                  {t('settings.timeZoneBrowser', { zone: browserZone })}
                </option>
              )}
              {shownZones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          )}
        </Field>

        <label className="flex items-start gap-2.5 text-sm text-ink">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={motionBackground}
            disabled={pending}
            onChange={(event) => {
              const next = event.target.checked;
              startTransition(async () => {
                await setMotionBackground(next);
              });
            }}
          />
          <span>
            {t('settings.motionLabel')}
            <span className="block text-xs text-ink-muted">{t('settings.motionHint')}</span>
          </span>
        </label>
      </div>
    </Card>
  );
}

import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { InterfaceSettings } from '@/components/interface-settings';
import { Card, Mono, Notice, PageHeader } from '@/components/ui/primitives';
import { REFRESH_CHOICES, refreshSeconds } from '@/lib/preferences';
import { tryGetSourceOffer } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('settings.title') };
}

/**
 * Settings.
 *
 * What this sidebar entry used to be was a page of read-only build facts called
 * Settings, which is a name for a page where you change something. Those facts
 * moved to Server management > About this server; this is the page that changes
 * things.
 *
 * Only per-viewer preferences live here, and the page is open to everyone —
 * anything that changes the installation for all of its users belongs behind
 * `system.manage` in Server management, not on a page any signed-in account can
 * open.
 *
 * The source offer at the bottom is not decoration. AGPLv3 section 13 requires
 * the Corresponding Source to be reachable by anyone interacting with the
 * software over a network, and Server management is administrators only — so the
 * offer needs a home every account can reach. This page and the footer link on
 * every screen are that home. See NOTICE and docs/architecture.md section 15.
 */
export default async function SettingsPage() {
  const [t, locale, refresh, source] = await Promise.all([
    getTranslations(),
    getLocale(),
    refreshSeconds(),
    tryGetSourceOffer(),
  ]);

  return (
    <>
      <PageHeader title={t('settings.title')} description={t('settings.subtitle')} />

      <div className="space-y-5">
        <InterfaceSettings
          locale={locale}
          refreshSeconds={refresh}
          refreshChoices={REFRESH_CHOICES}
        />

        <Card title={t('about.title')} description={t('settings.aboutBody')}>
          {source ? (
            <div className="space-y-3">
              <p className="text-sm text-ink">
                {source.product} <Mono>{source.version}</Mono> — <Mono>{source.license}</Mono>
              </p>

              <p className="text-sm text-ink-muted">
                {t('about.agplNotice', { product: source.product })}
              </p>

              <p>
                <a
                  href={source.url}
                  rel="noreferrer noopener"
                  target="_blank"
                  className="inline-flex h-8 items-center rounded border border-line-strong bg-surface-2 px-3 text-xs font-medium text-ink hover:bg-surface"
                >
                  {t('about.viewSource')}
                </a>
              </p>

              {/* Verbatim from the API. AGPLv3 section 7(b) — see NOTICE. */}
              <p className="text-xs text-ink-muted">{source.attribution}</p>
            </div>
          ) : (
            <Notice tone="error">{t('system.unreachable')}</Notice>
          )}
        </Card>
      </div>
    </>
  );
}

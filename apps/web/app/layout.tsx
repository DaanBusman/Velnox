import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';
import { Providers } from '@/components/providers';
import { Sidebar } from '@/components/sidebar';
import { Topbar } from '@/components/topbar';
import { tryGetSystemInfo } from '@/lib/api';
import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const info = await tryGetSystemInfo();
  const product = info?.product ?? 'Velnox';
  return {
    title: { default: product, template: `%s — ${product}` },
    description: 'Self-hosted MSP management platform for Proxmox VE fleets',
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [locale, messages, t, info] = await Promise.all([
    getLocale(),
    getMessages(),
    getTranslations(),
    tryGetSystemInfo(),
  ]);

  // The product name is read from the installation, not hardcoded, so rebranding
  // is a settings change (docs/architecture.md section 15).
  const product = info?.product ?? 'Velnox';
  const version = info?.version ?? '';

  return (
    <html lang={locale} suppressHydrationWarning>
      <body>
        <NextIntlClientProvider messages={messages}>
          <Providers>
            <a
              href="#main"
              className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-accent focus:px-3 focus:py-1.5 focus:text-xs focus:text-accent-contrast"
            >
              {t('layout.skipToContent')}
            </a>

            <div className="flex h-dvh overflow-hidden">
              <Sidebar product={product} />

              <div className="flex min-w-0 flex-1 flex-col">
                <Topbar locale={locale} />

                <main id="main" className="min-h-0 flex-1 overflow-y-auto">
                  <div className="mx-auto max-w-6xl px-6 py-6">{children}</div>

                  <footer className="mx-auto max-w-6xl px-6 pb-6 text-xs text-ink-muted">
                    {t('layout.footerLicense', { product, version })}{' '}
                    <a href="/settings/about" className="underline underline-offset-2">
                      {t('layout.footerSource')}
                    </a>
                  </footer>
                </main>
              </div>
            </div>
          </Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}

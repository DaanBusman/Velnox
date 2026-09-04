import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { Providers } from '@/components/providers';
import { tryGetSystemInfo } from '@/lib/api';
import './globals.css';

/**
 * The document shell, and nothing else.
 *
 * Navigation used to live here, which meant the sidebar and topbar rendered on
 * the sign-in page too — offering a signed-out visitor a menu of things they
 * cannot reach. The chrome now belongs to the authenticated group, and the
 * sign-in, setup and second-factor pages get a layout of their own.
 */
export async function generateMetadata(): Promise<Metadata> {
  const info = await tryGetSystemInfo();
  const product = info?.product ?? 'Velnox';
  return {
    title: { default: product, template: `%s — ${product}` },
    description: 'Self-hosted MSP management platform for Proxmox VE fleets',
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [locale, messages] = await Promise.all([getLocale(), getMessages()]);

  return (
    <html lang={locale} suppressHydrationWarning>
      <body>
        <NextIntlClientProvider messages={messages}>
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}

import { getLocale, getTranslations } from 'next-intl/server';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { ThemeToggle } from '@/components/theme-toggle';
import { ProductMark } from '@/components/ui/product-mark';
import { tryGetSystemInfo } from '@/lib/api';

/**
 * The way in: sign in, first-run setup, and the second-factor step.
 *
 * Deliberately without navigation. A signed-out visitor offered a sidebar full
 * of sections they cannot open learns nothing except that the product is broken.
 *
 * The language switch and theme toggle stay, because someone who cannot read the
 * sign-in page cannot sign in to change the setting.
 */
export default async function EntryLayout({ children }: { children: React.ReactNode }) {
  const [locale, t, info] = await Promise.all([
    getLocale(),
    getTranslations(),
    tryGetSystemInfo(),
  ]);
  const product = info?.product ?? 'Velnox';
  const version = info?.version ?? '';

  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <div className="flex items-center justify-end gap-2 px-4 py-3">
        <LocaleSwitcher current={locale} />
        <ThemeToggle />
      </div>

      <main
        id="main"
        className="flex flex-1 items-start justify-center px-4 pb-10 pt-4 sm:items-center sm:pt-0"
      >
        <div className="w-full max-w-md">
          <div className="mb-6 flex flex-col items-center gap-3">
            <ProductMark product={product} size={56} />
            <p className="text-lg font-semibold tracking-tight text-ink">{product}</p>
          </div>
          {children}
        </div>
      </main>

      <footer className="px-4 pb-6 text-center text-xs text-ink-muted">
        {t('layout.footerLicense', { product, version })}
      </footer>
    </div>
  );
}

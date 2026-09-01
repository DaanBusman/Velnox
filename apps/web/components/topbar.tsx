'use client';

import { useTranslations } from 'next-intl';
import { LocaleSwitcher } from './locale-switcher';
import { ThemeToggle } from './theme-toggle';

/**
 * Top bar.
 *
 * The tenant selector, global search and notifications from the brief's layout
 * are present but disabled, each stating the phase that makes it work. A control
 * that looks live and does nothing is worse than one that explains itself.
 */
export function Topbar({ locale }: { locale: string }) {
  const t = useTranslations();

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-surface px-4">
      <div
        className="flex h-7 items-center gap-2 rounded border border-line bg-surface-2 px-2 text-xs text-ink-muted"
        title={t('layout.tenantSelectorUnavailable')}
      >
        <span className="font-medium text-ink-muted">{t('layout.tenantSelector')}</span>
        <span className="text-ink-muted/70">—</span>
      </div>

      <label className="relative flex min-w-0 flex-1 items-center">
        <span className="sr-only">{t('common.search')}</span>
        <input
          type="search"
          disabled
          placeholder={t('layout.searchPlaceholder')}
          title={t('layout.searchUnavailable')}
          className="h-7 w-full max-w-md rounded border border-line bg-surface-2 px-2 text-xs text-ink placeholder:text-ink-muted disabled:cursor-not-allowed"
        />
      </label>

      <div className="flex shrink-0 items-center gap-2">
        <LocaleSwitcher current={locale} />
        <ThemeToggle />
      </div>
    </header>
  );
}

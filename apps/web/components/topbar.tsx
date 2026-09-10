'use client';

import { useTranslations } from 'next-intl';
import type { SessionUser } from '@/lib/session-types';
import { LocaleSwitcher } from './locale-switcher';
import { ThemeToggle } from './theme-toggle';
import { UserMenu } from './user-menu';

/**
 * Top bar.
 *
 * The tenant selector, global search and notifications from the brief's layout
 * are present but disabled, each stating the phase that makes it work. A control
 * that looks live and does nothing is worse than one that explains itself — so
 * the two that do not work yet are visibly recessed and carry the phase, rather
 * than sitting there looking clickable.
 */
export function Topbar({ locale, user }: { locale: string; user: SessionUser }) {
  const t = useTranslations();

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface/85 px-4 backdrop-blur-sm">
      <div
        className="flex h-8 items-center gap-2 rounded border border-dashed border-line bg-surface-2 px-2.5 text-xs text-ink-muted"
        title={t('layout.tenantSelectorUnavailable')}
      >
        <span className="font-medium">{t('layout.tenantSelector')}</span>
        <span className="opacity-60">—</span>
      </div>

      <label className="relative flex min-w-0 flex-1 items-center">
        <span className="sr-only">{t('common.search')}</span>
        <input
          type="search"
          disabled
          placeholder={t('layout.searchPlaceholder')}
          title={t('layout.searchUnavailable')}
          className="h-8 w-full max-w-md rounded border border-dashed border-line bg-surface-2 px-2.5 text-xs text-ink placeholder:text-ink-muted disabled:cursor-not-allowed"
        />
      </label>

      <div className="flex shrink-0 items-center gap-1.5">
        <LocaleSwitcher current={locale} />
        <ThemeToggle />
        <span aria-hidden className="mx-1 h-5 w-px bg-line" />
        <UserMenu user={user} />
      </div>
    </header>
  );
}

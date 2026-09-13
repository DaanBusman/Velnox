'use client';

import { useTranslations } from 'next-intl';
import type { SessionUser } from '@/lib/session-types';
import { LocaleSwitcher } from './locale-switcher';
import { TenantSelector, type SelectableTenant } from './tenant-selector';
import { ThemeToggle } from './theme-toggle';
import { UserMenu } from './user-menu';

/**
 * Top bar.
 *
 * The tenant selector works from Phase 3. Global search is still present and
 * disabled, stating the phase that makes it work: a control that looks live and
 * does nothing is worse than one that explains itself, so it is visibly recessed
 * and carries the phase rather than sitting there looking clickable.
 */
export function Topbar({
  locale,
  user,
  tenants,
  selectedTenantId,
}: {
  locale: string;
  user: SessionUser;
  tenants: SelectableTenant[];
  selectedTenantId: string | null;
}) {
  const t = useTranslations();

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface/85 px-4 backdrop-blur-sm">
      <TenantSelector tenants={tenants} selected={selectedTenantId} />

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

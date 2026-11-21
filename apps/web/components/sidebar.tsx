'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import clsx from 'clsx';
import { NAVIGATION, activeNavHref, isNavItemVisible, type NavViewer } from '@/lib/nav';
import { NAV_ICONS } from '@/components/ui/icons';
import { ProductMark } from '@/components/ui/product-mark';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { NavDrawerClose, NavDrawerPanel, useCloseNavDrawer } from '@/components/nav-drawer';
import { ServerManagement } from '@/components/server-management';
import { UpdateNotice } from '@/components/server/update-notice';
import { ThemeToggle } from '@/components/theme-toggle';

export function Sidebar({
  product,
  version,
  locale,
  permissions,
  viewer,
}: {
  product: string;
  version: string;
  locale: string;
  permissions: string[];
  viewer: NavViewer;
}) {
  const t = useTranslations();
  const pathname = usePathname();
  const closeDrawer = useCloseNavDrawer();
  const held = useMemo(() => new Set(permissions), [permissions]);
  const activeHref = activeNavHref(
    NAVIGATION.flatMap((group) =>
      group.items.filter((item) => isNavItemVisible(item, held, viewer)),
    ),
    pathname,
  );

  return (
    <NavDrawerPanel>
      <nav
        aria-label={t('layout.primaryNavigation')}
        className="flex h-full w-full flex-col border-r border-line bg-surface"
      >
        <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-line px-4">
          <ProductMark product={product} size={28} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold tracking-tight text-ink">
              {product}
            </span>
            {version && (
              <span className="block truncate font-mono text-[10px] leading-tight text-ink-muted">
                v{version}
              </span>
            )}
          </span>
          <NavDrawerClose />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2.5">
          {NAVIGATION.map((group, index) => {
            const items = group.items.filter((item) => isNavItemVisible(item, held, viewer));
            // A group whose every entry is gated away leaves no empty heading.
            if (items.length === 0) return null;

            return (
              <div key={group.labelKey ?? `group-${index}`} className="mb-1">
                {group.labelKey && (
                  <p className="px-2 pb-1 pt-3.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-muted">
                    {t(`layout.${group.labelKey}`)}
                  </p>
                )}
                <ul className="space-y-0.5">
                  {items.map((item) => {
                    const active = item.href === activeHref;
                    const Icon = NAV_ICONS[item.key];

                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          aria-current={active ? 'page' : undefined}
                          onClick={closeDrawer}
                          className={clsx(
                            'group flex items-center gap-2.5 rounded px-2 py-1.5 text-sm transition-colors max-lg:py-2.5',
                            active
                              ? 'bg-accent-soft font-medium text-accent shadow-card'
                              : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
                          )}
                        >
                          {Icon && (
                            <Icon
                              className={clsx(
                                'size-4 shrink-0 transition-colors',
                                active ? 'text-accent' : 'text-ink-muted group-hover:text-ink',
                              )}
                            />
                          )}
                          <span className="min-w-0 flex-1 truncate">{t(`nav.${item.key}`)}</span>
                          {/* A section that does not exist yet says so here, rather
                            than looking identical to one that works. */}
                          {item.phase !== null && (
                            <span
                              title={t('placeholder.plannedIn', { phase: item.phase })}
                              className="shrink-0 rounded border border-line bg-surface-2 px-1 font-mono text-[10px] text-ink-muted"
                            >
                              P{item.phase}
                            </span>
                          )}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>

        {/*
        Server management sits below the navigation rather than inside it,
        because it is not a destination: it opens over whatever you were doing
        and closes back onto it. Rendered only for someone who can actually use
        it — every panel inside needs `system.manage`, so for anyone else this
        would be a button that opens a window full of refusals.
      */}
        {held.has('system.manage') && (
          <div className="shrink-0 border-t border-line p-2">
            {/* A newer Velnox, above the window that says more about it (0.7.21). */}
            <UpdateNotice />
            <ServerManagement />
          </div>
        )}

        {/* The top bar has no room for these on a phone. */}
        <div className="grid shrink-0 grid-cols-2 gap-2 border-t border-line p-2 sm:hidden [&_label]:block [&_select]:h-9 [&_select]:w-full">
          <LocaleSwitcher current={locale} />
          <ThemeToggle />
        </div>
      </nav>
    </NavDrawerPanel>
  );
}

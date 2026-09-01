'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import clsx from 'clsx';
import { NAVIGATION } from '@/lib/nav';

export function Sidebar({ product }: { product: string }) {
  const t = useTranslations();
  const pathname = usePathname();

  return (
    <nav
      aria-label={t('layout.primaryNavigation')}
      className="flex h-full w-60 shrink-0 flex-col border-r border-line bg-surface"
    >
      <div className="flex h-12 items-center gap-2 border-b border-line px-4">
        <span
          aria-hidden
          className="grid size-6 place-items-center rounded bg-accent text-[11px] font-bold text-accent-contrast"
        >
          V
        </span>
        <span className="truncate text-sm font-semibold tracking-tight text-ink">{product}</span>
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {NAVIGATION.map((group, index) => (
          <div key={group.labelKey ?? `group-${index}`} className="mb-1">
            {group.labelKey && (
              <p className="px-4 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
                {t(`layout.${group.labelKey}`)}
              </p>
            )}
            <ul>
              {group.items.map((item) => {
                const active =
                  item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      className={clsx(
                        'flex items-center justify-between gap-2 px-4 py-1.5 text-sm',
                        active
                          ? 'bg-surface-2 font-medium text-ink shadow-[inset_2px_0_0_var(--velnox-accent)]'
                          : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
                      )}
                    >
                      <span className="truncate">{t(`nav.${item.key}`)}</span>
                      {/* A section that does not exist yet says so here, rather
                          than looking identical to one that works. */}
                      {item.phase !== null && (
                        <span
                          title={t('placeholder.plannedIn', { phase: item.phase })}
                          className="shrink-0 rounded bg-surface-2 px-1 font-mono text-[10px] text-ink-muted"
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
        ))}
      </div>
    </nav>
  );
}

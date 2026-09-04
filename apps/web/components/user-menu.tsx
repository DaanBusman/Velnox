'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { SessionUser } from '@/lib/session-types';
import { SignOutLink } from '@/components/sign-out-link';

/**
 * The account menu.
 *
 * Written rather than pulled from a library because the behaviour it needs is
 * small and specific: close on Escape, close on a click elsewhere, and return
 * focus to the button that opened it. That last one is the part libraries are
 * usually brought in for and the part hand-rolled menus usually miss — without
 * it, closing the menu drops keyboard focus to the top of the document.
 */
export function UserMenu({ user }: { user: SessionUser }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    }

    function onPointerDown(event: PointerEvent) {
      if (containerRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    }

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  const initials = user.displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex h-7 items-center gap-2 rounded border border-line bg-surface-2 pl-1 pr-2 text-xs text-ink hover:bg-surface"
      >
        <span
          aria-hidden
          className="grid size-5 place-items-center rounded-full bg-accent text-[10px] font-semibold text-accent-contrast"
        >
          {initials || '?'}
        </span>
        <span className="max-w-32 truncate">{user.displayName}</span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-1 w-64 rounded border border-line bg-surface p-1 shadow-lg"
        >
          <div className="border-b border-line px-3 py-2">
            <p className="truncate text-xs font-medium text-ink">{user.displayName}</p>
            <p className="truncate text-xs text-ink-muted">{user.email}</p>
          </div>

          {/*
            Stated rather than implied. Whether an account has a second factor
            is the kind of thing people assume they set up years ago, and the
            menu is where they look.
          */}
          <div className="border-b border-line px-3 py-2">
            <p className="text-xs text-ink-muted">
              {user.mfa.enrolled ? t('mfa.statusEnrolled') : t('mfa.statusNotEnrolled')}
            </p>
          </div>

          <Link
            role="menuitem"
            href="/settings/security"
            onClick={() => setOpen(false)}
            className="block rounded px-3 py-2 text-xs text-ink hover:bg-surface-2"
          >
            {t('nav.security')}
          </Link>

          <div className="px-3 py-2">
            <SignOutLink className="text-xs text-ink-muted underline underline-offset-2 hover:text-ink" />
          </div>
        </div>
      )}
    </div>
  );
}

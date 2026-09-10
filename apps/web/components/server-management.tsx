'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import clsx from 'clsx';
import { IconAudit, IconCertificate, IconClose, IconServer, IconUpdates } from '@/components/ui/icons';
import { AuditPanel } from '@/components/server/audit-panel';
import { CertificatePanel } from '@/components/server/certificate-panel';
import { UpdatesPanel } from '@/components/server/updates-panel';

/**
 * Server management.
 *
 * Everything about the Velnox installation *itself* — its audit trail, the
 * certificate it serves, the version it is running — as one window that opens
 * over whatever you were doing and closes back onto it. Grouping them was the
 * point: they were three unrelated sidebar entries sitting among tenant and
 * fleet administration, which are a different job done by different people.
 *
 * A window rather than a route, because that is what it is: you come here to
 * check or change something about the server, then go back to what you were
 * doing. Nothing here deep-links, and nothing here is somewhere you navigate to
 * and stay.
 *
 * The trigger is rendered only for `system.manage`, which in the shipped role
 * catalogue is the MSP Super Administrator alone. Every panel inside is refused
 * by the API without it as well — this decides what to offer, not what to allow.
 */

type TabKey = 'audit' | 'certificate' | 'updates';

const TABS: { key: TabKey; icon: typeof IconAudit }[] = [
  { key: 'audit', icon: IconAudit },
  { key: 'certificate', icon: IconCertificate },
  { key: 'updates', icon: IconUpdates },
];

export function ServerManagement() {
  const t = useTranslations();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={clsx(
          'flex w-full items-center gap-2.5 rounded px-2 py-2 text-sm font-medium transition-colors',
          'border border-line bg-surface-2 text-ink shadow-card velnox-lit',
          'hover:border-line-strong hover:bg-surface-3',
        )}
      >
        <IconServer className="size-4 shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate text-left">{t('server.open')}</span>
      </button>

      {open && <ServerWindow onClose={() => setOpen(false)} />}
    </>
  );
}

function ServerWindow({ onClose }: { onClose: () => void }) {
  const t = useTranslations();
  const [tab, setTab] = useState<TabKey>('audit');
  const [mounted, setMounted] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Portals need a document, which the server render does not have.
  useEffect(() => setMounted(true), []);

  /*
   * Where focus was before this opened, so it can go back.
   *
   * Without it, closing drops focus onto <body> and a keyboard user has to tab
   * from the top of the page to get back to where they were.
   */
  const returnFocusTo = useRef<HTMLElement | null>(null);
  useEffect(() => {
    returnFocusTo.current = document.activeElement as HTMLElement | null;
    return () => returnFocusTo.current?.focus?.();
  }, []);

  useEffect(() => {
    if (mounted) closeRef.current?.focus();
  }, [mounted]);

  // The page behind must not scroll under the window.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  /**
   * Escape closes; Tab stays inside.
   *
   * A modal that lets focus wander out is a modal only for people using a
   * mouse: everyone else tabs straight into the page behind it and cannot tell
   * where they are.
   */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }

      if (event.key !== 'Tab') return;

      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable || focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  if (!mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex flex-col bg-scrim velnox-scrim-in p-0 sm:p-4 md:p-6"
      // Not a click-to-dismiss backdrop. The window fills the viewport, so the
      // only clickable scrim is a thin frame — and dismissing a window full of
      // an operator's work because they missed an edge is a bad trade.
      onKeyDown={onKeyDown}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="server-management-title"
        className={clsx(
          'velnox-panel-in flex min-h-0 flex-1 flex-col overflow-hidden',
          'border border-line bg-bg shadow-panel',
          'rounded-none sm:rounded-lg',
        )}
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-line bg-surface px-4 py-3 sm:px-5">
          <span
            aria-hidden
            className="grid size-8 shrink-0 place-items-center rounded-md bg-accent-soft text-accent"
          >
            <IconServer className="size-4" />
          </span>

          <div className="min-w-0 flex-1">
            <h2
              id="server-management-title"
              className="truncate text-sm font-semibold tracking-tight text-ink"
            >
              {t('server.title')}
            </h2>
            <p className="truncate text-xs text-ink-muted">{t('server.subtitle')}</p>
          </div>

          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={t('server.close')}
            title={`${t('server.close')} (Esc)`}
            className={clsx(
              'grid size-8 shrink-0 place-items-center rounded-md transition-colors',
              'border border-line bg-surface-2 text-ink-muted',
              'hover:border-line-strong hover:bg-surface-3 hover:text-ink',
            )}
          >
            <IconClose className="size-4" />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <nav
            aria-label={t('server.sections')}
            className="shrink-0 border-b border-line bg-surface px-2 py-2 md:w-52 md:border-b-0 md:border-r md:py-3"
          >
            <ul className="flex gap-1 md:flex-col md:gap-0.5">
              {TABS.map(({ key, icon: Icon }) => {
                const active = tab === key;
                return (
                  <li key={key} className="min-w-0 flex-1 md:flex-none">
                    <button
                      type="button"
                      onClick={() => setTab(key)}
                      aria-current={active ? 'true' : undefined}
                      className={clsx(
                        'flex w-full items-center gap-2.5 rounded px-2.5 py-2 text-sm transition-colors',
                        active
                          ? 'bg-accent-soft font-medium text-accent shadow-card'
                          : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
                      )}
                    >
                      <Icon className="size-4 shrink-0" />
                      <span className="min-w-0 truncate">{t(`server.tab.${key}`)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
            <div className="mx-auto max-w-5xl">
              {tab === 'audit' && <AuditPanel />}
              {tab === 'certificate' && <CertificatePanel />}
              {tab === 'updates' && <UpdatesPanel />}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

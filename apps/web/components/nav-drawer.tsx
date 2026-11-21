'use client';

import { usePathname } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { useTranslations } from 'next-intl';
import { IconClose, IconMenu } from '@/components/ui/icons';
import { wrappedFocusIndex } from '@/lib/focus-trap';

/**
 * The sidebar as a drawer, below the `lg` breakpoint.
 *
 * One navigation, placed by CSS (`.velnox-drawer`): beside the page from `lg`
 * up, and off-canvas under it. Rendering a second copy for phones would mean two
 * sets of links and two Server management windows to keep in step.
 *
 * While open it is a modal: the page behind is inert, Tab stays inside, Escape
 * closes, and focus goes back to the menu button.
 */

const PANEL_ID = 'velnox-nav-drawer';
const WIDE_ENOUGH_FOR_SIDEBAR = '(min-width: 64rem)';
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface NavDrawerState {
  open: boolean;
  show: () => void;
  close: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}

const NavDrawerContext = createContext<NavDrawerState | null>(null);

function useNavDrawer(): NavDrawerState {
  const state = useContext(NavDrawerContext);
  if (!state) throw new Error('Needs a NavDrawerProvider above it.');
  return state;
}

/** For a link in the drawer: a link to the current page changes no path. */
export function useCloseNavDrawer(): () => void {
  return useNavDrawer().close;
}

export function NavDrawerProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const show = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => setOpen(false), [pathname]);

  // Turning a tablet or widening a window puts the sidebar back beside the page,
  // where an open drawer would leave the page inert with no scrim to dismiss.
  useEffect(() => {
    const wide = window.matchMedia(WIDE_ENOUGH_FOR_SIDEBAR);
    const onChange = (event: MediaQueryListEvent) => {
      if (event.matches) setOpen(false);
    };
    wide.addEventListener('change', onChange);
    return () => wide.removeEventListener('change', onChange);
  }, []);

  const value = useMemo(() => ({ open, show, close, triggerRef }), [open, show, close]);

  return <NavDrawerContext.Provider value={value}>{children}</NavDrawerContext.Provider>;
}

/** The menu button in the top bar. */
export function NavDrawerButton() {
  const t = useTranslations();
  const { open, show, triggerRef } = useNavDrawer();

  return (
    <button
      ref={triggerRef}
      type="button"
      onClick={show}
      aria-label={t('layout.openMenu')}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={PANEL_ID}
      className="grid size-9 shrink-0 place-items-center rounded border border-line bg-surface-2 text-ink-muted transition-colors hover:border-line-strong hover:bg-surface-3 hover:text-ink lg:hidden"
    >
      <IconMenu className="size-4" />
    </button>
  );
}

/** The close button in the drawer's header. Absent beside the page. */
export function NavDrawerClose() {
  const t = useTranslations();
  const { close } = useNavDrawer();

  return (
    <button
      type="button"
      onClick={close}
      aria-label={t('layout.closeMenu')}
      className="grid size-9 shrink-0 place-items-center rounded border border-line bg-surface-2 text-ink-muted transition-colors hover:border-line-strong hover:bg-surface-3 hover:text-ink lg:hidden"
    >
      <IconClose className="size-4" />
    </button>
  );
}

/** The page column, taken out of reach while the drawer covers it. */
export function NavDrawerPage({ children }: { children: ReactNode }) {
  const { open } = useNavDrawer();

  return (
    <div inert={open} className="flex min-w-0 flex-1 flex-col">
      {children}
    </div>
  );
}

export function NavDrawerPanel({ children }: { children: ReactNode }) {
  const t = useTranslations();
  const { open, close, triggerRef } = useNavDrawer();
  const panelRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open) {
      visibleFocusable(panelRef.current)[0]?.focus();
    } else if (wasOpen.current) {
      triggerRef.current?.focus();
    }
    wasOpen.current = open;
  }, [open, triggerRef]);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      const panel = panelRef.current;
      if (!panel) return;

      // Server management opens over the drawer, from inside it, and handles
      // its own keys. Escape there closes that window and nothing else.
      const coveredByAnother = Array.from(document.querySelectorAll('[aria-modal="true"]')).some(
        (modal) => modal !== panel,
      );
      if (coveredByAnother) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }

      if (event.key !== 'Tab') return;

      const focusable = visibleFocusable(panel);
      const active = focusable.indexOf(document.activeElement as HTMLElement);
      const target = wrappedFocusIndex(focusable.length, active, event.shiftKey);
      if (target === null) return;
      event.preventDefault();
      focusable[target]?.focus();
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, close]);

  return (
    <>
      {open && (
        <div
          aria-hidden
          onClick={close}
          className="velnox-scrim-in fixed inset-0 z-40 bg-scrim lg:hidden"
        />
      )}
      <div
        ref={panelRef}
        id={PANEL_ID}
        role={open ? 'dialog' : undefined}
        aria-modal={open ? true : undefined}
        aria-label={open ? t('layout.menu') : undefined}
        tabIndex={open ? -1 : undefined}
        data-open={open}
        className="velnox-drawer h-full w-60 shrink-0"
      >
        {children}
      </div>
    </>
  );
}

/** Controls hidden at this width (the drawer's language and theme) are skipped. */
function visibleFocusable(panel: HTMLElement | null): HTMLElement[] {
  if (!panel) return [];
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => element.getClientRects().length > 0,
  );
}

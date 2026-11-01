'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { CACHE_PREFIX } from '@/lib/pwa/service-worker';

/**
 * Velnox as an installed app (ADR-058): the service worker registered, the
 * browser's offer to install kept for the user menu's button, and a notice
 * when the server was updated under an open window.
 *
 * Whether it can be installed is the browser's to say. It says yes through
 * `beforeinstallprompt` (Edge and Chrome), and no by refusing the service
 * worker — which is what an untrusted certificate gets, `tls internal`
 * without Caddy's root on the workstation included.
 */

/** Not in TypeScript's DOM library: the event Edge and Chrome send. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type InstallState =
  /** Nothing to offer: the browser did not offer it, or not yet. */
  | 'unavailable'
  /** The browser offers it; the button may ask. */
  | 'available'
  /** Running as the installed app. */
  | 'installed'
  /** The browser refused the service worker: not a secure, trusted origin. */
  | 'untrusted';

interface Pwa {
  state: InstallState;
  install(): Promise<void>;
}

const PwaContext = createContext<Pwa>({ state: 'unavailable', install: async () => {} });

export const usePwa = () => useContext(PwaContext);

/** Every cache the service worker made — on signing out, so nothing stays behind. */
export async function clearAppCaches(): Promise<void> {
  if (typeof caches === 'undefined') return;
  for (const key of await caches.keys()) {
    if (key.startsWith(CACHE_PREFIX)) await caches.delete(key);
  }
}

export function PwaProvider({ children }: { children: ReactNode }) {
  const t = useTranslations('pwa');
  const [state, setState] = useState<InstallState>('unavailable');
  const [offer, setOffer] = useState<BeforeInstallPromptEvent | null>(null);
  const [updated, setUpdated] = useState(false);

  useEffect(() => {
    if (window.matchMedia('(display-mode: standalone)').matches) setState('installed');
    if (!('serviceWorker' in navigator) || process.env.NODE_ENV !== 'production') return;
    if (!window.isSecureContext) {
      setState((s) => (s === 'installed' ? s : 'untrusted'));
      return;
    }

    // A worker taking over a window that already had one is a new build of
    // Velnox: the window's own code is the old one until it is reloaded.
    const hadController = navigator.serviceWorker.controller !== null;
    const onControllerChange = () => {
      if (hadController) setUpdated(true);
    };
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

    let registration: ServiceWorkerRegistration | null = null;
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((r) => {
        registration = r;
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'SecurityError') {
          setState((s) => (s === 'installed' ? s : 'untrusted'));
        }
      });
    // Navigation inside the app does not make the browser look for a new
    // worker; coming back to the window does.
    const onVisible = () => {
      if (document.visibilityState === 'visible') registration?.update().catch(() => {});
    };
    document.addEventListener('visibilitychange', onVisible);

    const onOffer = (event: Event) => {
      event.preventDefault();
      setOffer(event as BeforeInstallPromptEvent);
      setState('available');
    };
    const onInstalled = () => {
      setOffer(null);
      setState('installed');
    };
    window.addEventListener('beforeinstallprompt', onOffer);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('beforeinstallprompt', onOffer);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = useCallback(async () => {
    if (!offer) return;
    await offer.prompt();
    const { outcome } = await offer.userChoice;
    // The browser offers once per event; after a no, it sends a new one later.
    setOffer(null);
    setState(outcome === 'accepted' ? 'installed' : 'unavailable');
  }, [offer]);

  return (
    <PwaContext.Provider value={{ state, install }}>
      {children}
      {updated && (
        <div
          role="status"
          className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded border border-line bg-surface px-4 py-3 text-xs text-ink shadow-lg"
        >
          <span>{t('updated')}</span>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded bg-accent px-2 py-1 font-medium text-accent-contrast"
          >
            {t('reload')}
          </button>
        </div>
      )}
    </PwaContext.Provider>
  );
}

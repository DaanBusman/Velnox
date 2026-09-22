'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Re-read the page from the server on an interval.
 *
 * The inventory screens are Server Components over `force-dynamic` pages, so
 * `router.refresh()` re-runs the page's own data fetch and swaps the result in
 * without touching client state: a half-typed search box, an open form and the
 * scroll position all survive. That is the whole reason this is a refresh and
 * not a reload.
 *
 * Two things it deliberately does not do:
 *
 * - **It does not poll a hidden tab.** An operator with six Velnox tabs open
 *   would otherwise have six of these running for as long as the browser is up,
 *   and every one of them costs the API a full cluster list. It stops on
 *   `visibilitychange` and refreshes once on the way back, so returning to a
 *   tab shows current data rather than whatever was on screen last week.
 * - **It does not talk to Proxmox.** This re-reads what Velnox already knows.
 *   Discovery runs on its own schedule, per cluster; nothing here shortens it.
 */
export function useAutoRefresh(intervalMs: number, enabled = true): void {
  const router = useRouter();

  useEffect(() => {
    if (!enabled) return;

    let timer: ReturnType<typeof setInterval> | null = null;

    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const start = () => {
      if (timer === null) timer = setInterval(() => router.refresh(), intervalMs);
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        router.refresh();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [router, intervalMs, enabled]);
}

/** How often the inventory screens re-read themselves. */
export const INVENTORY_REFRESH_MS = 2_000;

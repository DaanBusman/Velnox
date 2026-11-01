'use client';

import { useRouter } from 'next/navigation';
import { useRefreshOn, type RefreshOn } from '@/lib/changes';

/**
 * Re-read the page from the server when what it shows changes, or on an
 * interval.
 *
 * Given `on`, it refreshes when the change stream says something it shows
 * moved, never more often than the interval (see useRefreshOn), and falls back
 * to the interval whenever no stream is open. Without `on` it is the interval.
 *
 * The inventory screens are Server Components over `force-dynamic` pages, so
 * `router.refresh()` re-runs the page's own data fetch and swaps the result in
 * without touching client state: a half-typed search box, an open form and the
 * scroll position all survive. That is the whole reason this is a refresh and
 * not a reload.
 *
 * **It stops while the user is in the middle of something.** Pass `enabled:
 * false` and no interval runs and no listener is registered. This is not a
 * nicety: `router.refresh()` re-renders the *layout* as well as the page, and
 * the shell layout returns a different tree entirely when `getSession()` comes
 * back empty — which unmounts everything below it, half-filled forms included.
 * Refreshing every two seconds turns that from a rare event into a routine one.
 *
 * Two more things it deliberately does not do (nor does the stream):
 *
 * - **It does not poll a hidden tab.** An operator with six Velnox tabs open
 *   would otherwise have six of these running for as long as the browser is up,
 *   and every one of them costs the API a full cluster list. It stops on
 *   `visibilitychange` and refreshes once on the way back, so returning to a
 *   tab shows current data rather than whatever was on screen last week.
 * - **It does not talk to Proxmox.** This re-reads what Velnox already knows.
 *   Discovery runs on its own schedule, per cluster; nothing here shortens it.
 */
export function useAutoRefresh(intervalMs: number, enabled = true, on?: RefreshOn): void {
  const router = useRouter();
  useRefreshOn(() => router.refresh(), intervalMs, enabled, on);
}

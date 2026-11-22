'use client';

import { useSyncExternalStore } from 'react';

const noSubscription = () => () => undefined;

/**
 * The instant to measure a running time from, on a screen that keeps counting.
 *
 * The server's render time while the page hydrates, so the browser's first
 * render produces the text the server sent (React error #418 otherwise), and
 * the browser's own clock on every render after that.
 *
 * A table that is re-read from the server does not need this: it takes
 * `renderedAt` as its "now" directly, and a re-read brings a new one.
 */
export function useClock(renderedAt: string): number {
  const hydrated = useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
  return hydrated ? Date.now() : Date.parse(renderedAt);
}

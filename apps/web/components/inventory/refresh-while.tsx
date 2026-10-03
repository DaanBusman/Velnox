'use client';

import { useAutoRefresh } from '@/lib/use-auto-refresh';

/**
 * Re-read a server-rendered page on the viewer's refresh interval, but only
 * while something on it is still changing — a VM being built, say. A page with
 * nothing under way costs the API nothing.
 */
export function RefreshWhile({ active, seconds }: { active: boolean; seconds: number }) {
  useAutoRefresh(seconds * 1000, active && seconds > 0);
  return null;
}

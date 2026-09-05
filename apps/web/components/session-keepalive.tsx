'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { apiPost } from '@/lib/client-api';

/**
 * Keeping a signed-in session signed in.
 *
 * The access token lives fifteen minutes; the refresh token eight hours on a
 * sliding window. Without this, someone reading a long page and then clicking
 * something would be thrown back to the sign-in form with their work lost,
 * which is the difference between a session policy and an annoyance.
 *
 * Why a timer in the browser rather than middleware on the server: the refresh
 * cookie is scoped to `/api/v1/auth`, so the browser does not attach it to an
 * ordinary page request and the server never sees it. Widening that path would
 * put the refresh token on every request for every stylesheet and image, which
 * is a worse trade than a timer.
 *
 * Rotation means each refresh invalidates the previous token, and presenting an
 * already-rotated one revokes the whole family — so this must never run twice
 * concurrently. Hence the guard.
 */

/** Comfortably inside the fifteen-minute access token, with room for a retry. */
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;

export function SessionKeepAlive() {
  const router = useRouter();
  const inFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      // Two overlapping refreshes would present the same token twice, which the
      // API correctly treats as theft and answers by revoking every session in
      // the family.
      if (inFlight.current) return;
      inFlight.current = true;

      try {
        const result = await apiPost('/auth/refresh');
        if (cancelled) return;

        if (!result.ok) {
          // The refresh token is gone, expired or revoked. There is nothing to
          // recover; let the server-rendered gate send them to sign in.
          router.refresh();
        }
      } finally {
        inFlight.current = false;
      }
    }

    const timer = window.setInterval(refresh, REFRESH_INTERVAL_MS);

    // A tab left in the background gets no timer ticks in some browsers, so a
    // session can be stale the moment it is looked at again.
    function onVisible() {
      if (document.visibilityState === 'visible') void refresh();
    }
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [router]);

  return null;
}

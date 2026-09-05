'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { apiPost } from '@/lib/client-api';

/**
 * The gap between an expired access token and a still-valid session.
 *
 * Coming back to a tab after twenty minutes, the access token has expired but
 * the refresh token has hours left. The server cannot tell: the refresh cookie
 * is scoped to `/api/v1/auth`, so a page request does not carry it, and
 * `/auth/me` simply answers 401. Redirecting to the sign-in form at that point
 * would be asking someone to authenticate again while they are still signed in.
 *
 * So instead of redirecting, the page renders this, which asks the browser —
 * which does hold the refresh cookie — to exchange it. On success the page
 * reloads into the session that was there all along. On failure the session is
 * genuinely over and the sign-in form is the right answer.
 *
 * Exactly one attempt. A refresh that fails will fail again, and retrying an
 * already-rotated token is what reuse detection revokes families for.
 */
export function SessionRecovery() {
  const t = useTranslations();
  const router = useRouter();
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;

    let cancelled = false;

    void (async () => {
      const result = await apiPost('/auth/refresh');
      if (cancelled) return;

      if (result.ok) {
        router.refresh();
      } else {
        router.replace('/login');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas px-4">
      {/* Announced, not just drawn: a screen-reader user gets no signal from a
          spinner, and this is the only thing on the page for a moment. */}
      <p role="status" className="text-sm text-ink-muted">
        {t('auth.restoringSession')}
      </p>
    </div>
  );
}

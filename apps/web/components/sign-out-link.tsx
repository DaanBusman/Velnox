'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { apiPost } from '@/lib/client-api';

/**
 * Signing out.
 *
 * A POST, not a link: a GET that ends a session can be triggered by any image
 * tag on any page. It also has to work from a session that still owes a second
 * factor — being unable to leave a half-finished sign-in is how someone ends up
 * clearing cookies by hand.
 */
export function SignOutLink({ className }: { className?: string }) {
  const t = useTranslations();
  const router = useRouter();
  const [pending, setPending] = useState(false);

  return (
    <button
      type="button"
      disabled={pending}
      className={className ?? 'underline underline-offset-2 hover:text-ink'}
      onClick={async () => {
        setPending(true);
        // The cookies are cleared by the API's response. Even if the call fails,
        // sending the user to the sign-in page is better than leaving them on a
        // screen they were trying to leave.
        await apiPost('/auth/logout');
        router.replace('/login');
        router.refresh();
      }}
    >
      {t('auth.signOut')}
    </button>
  );
}

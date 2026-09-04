import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { MfaChallenge } from '@/components/mfa-challenge';
import { MfaEnrolment } from '@/components/mfa-enrolment';
import { SignOutLink } from '@/components/sign-out-link';
import { getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('mfa.challengeTitle') };
}

/**
 * The second-factor step.
 *
 * Two different situations arrive here. Someone with a factor answers a
 * challenge. Someone whose installation requires a factor they have never
 * enrolled has to enrol before anything else opens — which is the case that
 * makes a required policy mean something rather than being satisfied by
 * ignoring it.
 */
export default async function MfaPage() {
  const [session, t] = await Promise.all([getSession(), getTranslations()]);

  if (!session) redirect('/login');
  if (session.mfaSatisfied) redirect('/');

  return (
    <div className="space-y-4">
      {session.user.mfa.enrolled ? <MfaChallenge /> : <MfaEnrolment required />}

      <p className="text-center text-xs text-ink-muted">
        {t('mfa.signedInAs', { email: session.user.email })} <SignOutLink />
      </p>
    </div>
  );
}

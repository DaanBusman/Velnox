import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { LoginForm } from '@/components/login-form';
import { Notice } from '@/components/ui/primitives';
import { tryGetSystemInfo } from '@/lib/api';
import { getSession, getSetupStatus } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('auth.signIn') };
}

export default async function LoginPage() {
  const [setup, session, info, t] = await Promise.all([
    getSetupStatus(),
    getSession(),
    tryGetSystemInfo(),
    getTranslations(),
  ]);

  // Nothing to sign in to yet.
  if (setup && !setup.initialized) redirect('/setup');

  // Already signed in. Sending a satisfied session to the dashboard and an
  // unsatisfied one to the second factor keeps the back button from landing
  // someone on a sign-in form they have already filled in.
  if (session) redirect(session.mfaSatisfied ? '/' : '/mfa');

  const ssoEnabled = info?.features?.microsoftSso === true;

  return (
    <div className="space-y-4">
      <LoginForm ssoEnabled={ssoEnabled} />

      {setup === null && (
        <Notice tone="warn" title={t('auth.apiUnreachableTitle')}>
          {t('auth.apiUnreachableBody')}
        </Notice>
      )}
    </div>
  );
}

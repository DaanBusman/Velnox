import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { SecuritySettings } from '@/components/security-settings';
import { PageHeader } from '@/components/ui/primitives';
import { getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('nav.security') };
}

export default async function SecuritySettingsPage() {
  const [session, t] = await Promise.all([getSession(), getTranslations()]);
  if (!session) redirect('/login');

  return (
    <>
      <PageHeader title={t('nav.security')} description={t('security.subtitle')} />
      <SecuritySettings user={session.user} />
    </>
  );
}

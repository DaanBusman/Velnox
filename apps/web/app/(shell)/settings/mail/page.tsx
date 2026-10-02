import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { MailSettings } from '@/components/settings/mail-settings';
import { Notice, PageHeader } from '@/components/ui/primitives';
import { getMailSettings, getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('nav.mail') };
}

export default async function MailSettingsPage() {
  const [session, settings, t] = await Promise.all([
    getSession(),
    getMailSettings(),
    getTranslations(),
  ]);
  if (!session) redirect('/login');

  if (!settings.ok) {
    return (
      <>
        <PageHeader title={t('nav.mail')} />
        <Notice tone={settings.code === 'authz.forbidden' ? 'warn' : 'error'}>
          {settings.code === 'authz.forbidden'
            ? t('common.requiresPermission', { permission: 'system.manage' })
            : t('errors.generic')}
        </Notice>
      </>
    );
  }

  return (
    <>
      <PageHeader title={t('nav.mail')} description={t('mail.subtitle')} />
      <MailSettings initial={settings.data} defaultTo={session.user.email} />
    </>
  );
}

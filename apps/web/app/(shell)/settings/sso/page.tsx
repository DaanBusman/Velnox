import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { SsoSettings } from '@/components/sso-settings';
import { Notice, PageHeader } from '@/components/ui/primitives';
import { getIdentityProvider, getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('nav.sso') };
}

export default async function SsoSettingsPage() {
  const [session, provider, t] = await Promise.all([
    getSession(),
    getIdentityProvider(),
    getTranslations(),
  ]);

  if (!session) redirect('/login');

  if (!provider.ok) {
    return (
      <>
        <PageHeader title={t('nav.sso')} />
        <Notice tone={provider.code === 'authz.forbidden' ? 'warn' : 'error'}>
          {provider.code === 'authz.forbidden'
            ? t('common.requiresPermission', { permission: 'system.manage' })
            : t('errors.generic')}
        </Notice>
      </>
    );
  }

  return (
    <>
      <PageHeader title={t('nav.sso')} description={t('sso.subtitle')} />
      <SsoSettings initial={provider.data} />
    </>
  );
}

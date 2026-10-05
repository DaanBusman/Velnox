import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { SecuritySettings } from '@/components/security-settings';
import { SsoSettings } from '@/components/sso-settings';
import { Notice, PageHeader } from '@/components/ui/primitives';
import { getIdentityProvider, getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('nav.security') };
}

/**
 * Security: the viewer's own sign-in — password, second factor — and, for whoever
 * administers the installation, single sign-on for everyone, which used to be a
 * page of its own.
 */
export default async function SecuritySettingsPage() {
  const [session, t] = await Promise.all([getSession(), getTranslations()]);
  if (!session) redirect('/login');

  const canManageSso = session.user.permissions.includes('system.manage');
  const provider = canManageSso ? await getIdentityProvider() : null;

  return (
    <>
      <PageHeader title={t('nav.security')} description={t('security.subtitle')} />
      <SecuritySettings user={session.user} />
      {provider && (
        <section id="sso" className="mt-8 scroll-mt-6">
          <h2 className="text-lg font-semibold tracking-tight text-ink">{t('nav.sso')}</h2>
          <p className="mb-4 mt-1 text-sm text-ink-muted">{t('sso.subtitle')}</p>
          {provider.ok ? (
            <SsoSettings initial={provider.data} />
          ) : (
            <Notice tone={provider.code === 'authz.forbidden' ? 'warn' : 'error'}>
              {provider.code === 'authz.forbidden'
                ? t('common.requiresPermission', { permission: 'system.manage' })
                : t('errors.generic')}
            </Notice>
          )}
        </section>
      )}
    </>
  );
}

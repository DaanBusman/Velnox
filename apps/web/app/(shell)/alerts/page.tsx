import { getTranslations } from 'next-intl/server';
import { Notice, PageHeader } from '@/components/ui/primitives';
import { AlertTable } from '@/components/inventory/tables';
import { listAlerts } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('nav.alerts') };
}

export default async function AlertsPage() {
  const [t, alerts] = await Promise.all([getTranslations(), listAlerts()]);

  if (!alerts.ok) {
    return (
      <>
        <PageHeader title={t('nav.alerts')} />
        <Notice tone={alerts.code === 'authz.forbidden' ? 'warn' : 'error'}>
          {alerts.code === 'authz.forbidden'
            ? t('common.requiresPermission', { permission: 'alerts.read' })
            : t('errors.generic')}
        </Notice>
      </>
    );
  }

  return (
    <>
      <PageHeader title={t('nav.alerts')} description={t('alerts.pageDescription')} />

      {/* Said once, here, rather than implied by a screen that looks like a
          notification system and is not one. */}
      <div className="mb-4">
        <Notice tone="neutral">{t('alerts.derivedExplainer')}</Notice>
      </div>

      <AlertTable alerts={alerts.data.alerts} />
    </>
  );
}

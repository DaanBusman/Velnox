import { getTranslations } from 'next-intl/server';
import { Notice, PageHeader } from '@/components/ui/primitives';
import { InterfaceTable } from '@/components/inventory/tables';
import { listInterfaces } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('nav.networks') };
}

export default async function NetworksPage() {
  const [t, interfaces] = await Promise.all([getTranslations(), listInterfaces()]);

  if (!interfaces.ok) {
    return (
      <>
        <PageHeader title={t('nav.networks')} />
        <Notice tone={interfaces.code === 'authz.forbidden' ? 'warn' : 'error'}>
          {interfaces.code === 'authz.forbidden'
            ? t('common.requiresPermission', { permission: 'networks.read' })
            : t('errors.generic')}
        </Notice>
      </>
    );
  }

  return (
    <>
      <PageHeader title={t('nav.networks')} description={t('inventory.networksPageDescription')} />
      <InterfaceTable interfaces={interfaces.data.interfaces} />
    </>
  );
}

import { getTranslations } from 'next-intl/server';
import { Notice, PageHeader } from '@/components/ui/primitives';
import { StorageTable } from '@/components/inventory/tables';
import { listStorages } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('nav.storage') };
}

export default async function StoragePage() {
  const [t, storages] = await Promise.all([getTranslations(), listStorages()]);

  if (!storages.ok) {
    return (
      <>
        <PageHeader title={t('nav.storage')} />
        <Notice tone={storages.code === 'authz.forbidden' ? 'warn' : 'error'}>
          {storages.code === 'authz.forbidden'
            ? t('common.requiresPermission', { permission: 'storage.read' })
            : t('errors.generic')}
        </Notice>
      </>
    );
  }

  return (
    <>
      <PageHeader title={t('nav.storage')} description={t('inventory.storagePageDescription')} />
      <StorageTable storages={storages.data.storages} />
    </>
  );
}

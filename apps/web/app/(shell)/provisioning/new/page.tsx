import { getTranslations } from 'next-intl/server';
import { Notice, PageHeader } from '@/components/ui/primitives';
import { ProvisionForm } from '@/components/provisioning/provision-form';
import { getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('provisioning.newTitle') };
}

export default async function NewProvisioningPage({
  searchParams,
}: {
  searchParams: Promise<{ templateId?: string }>;
}) {
  const { templateId } = await searchParams;
  const [t, session] = await Promise.all([getTranslations(), getSession()]);
  const allowed = session?.user.permissions.includes('workloads.provision') ?? false;

  return (
    <>
      <PageHeader
        title={t('provisioning.newTitle')}
        description={t('provisioning.newDescription')}
      />
      {allowed ? (
        <ProvisionForm
          initialTemplateId={templateId && /^[0-9a-f-]{36}$/i.test(templateId) ? templateId : null}
        />
      ) : (
        <Notice tone="warn">
          {t('common.requiresPermission', { permission: 'workloads.provision' })}
        </Notice>
      )}
    </>
  );
}

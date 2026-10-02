import { getTranslations } from 'next-intl/server';
import { Notice, PageHeader } from '@/components/ui/primitives';
import { TemplateEditor } from '@/components/autoconfig/template-editor';
import { getSession, listLibrary, listTenants } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('autoconfig.newTitle') };
}

export default async function NewTemplatePage({
  searchParams,
}: {
  searchParams: Promise<{ family?: string }>;
}) {
  const { family } = await searchParams;
  const [t, session, tenants, library] = await Promise.all([
    getTranslations(),
    getSession(),
    listTenants(),
    listLibrary(),
  ]);
  const chosen = family === 'LINUX' ? 'LINUX' : 'WINDOWS';

  if (!session?.user.permissions.includes('autoconfig.manage')) {
    return (
      <>
        <PageHeader title={t('autoconfig.newTitle')} />
        <Notice tone="warn">
          {t('common.requiresPermission', { permission: 'autoconfig.manage' })}
        </Notice>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={chosen === 'WINDOWS' ? t('autoconfig.newWindows') : t('autoconfig.newLinux')}
        description={t('autoconfig.subtitle')}
      />
      <TemplateEditor
        family={chosen}
        template={null}
        tenants={tenants.ok ? tenants.data.tenants : []}
        library={library.ok ? library.data.items : []}
      />
    </>
  );
}

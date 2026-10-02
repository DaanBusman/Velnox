import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Notice, PageHeader } from '@/components/ui/primitives';
import { TemplateEditor } from '@/components/autoconfig/template-editor';
import { getTemplate, listLibrary, listTenants } from '@/lib/session';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props) {
  const { id } = await params;
  const template = await getTemplate(id);
  const t = await getTranslations();
  return { title: template.ok ? template.data.name : t('nav.autoconfig') };
}

export default async function TemplatePage({ params }: Props) {
  const { id } = await params;
  const [t, template, tenants, library] = await Promise.all([
    getTranslations(),
    getTemplate(id),
    listTenants(),
    listLibrary(),
  ]);
  if (!template.ok && template.code === 'not_found') notFound();
  if (!template.ok) {
    return (
      <>
        <PageHeader title={t('nav.autoconfig')} />
        <Notice tone="error">{t('errors.generic')}</Notice>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={template.data.name}
        description={
          template.data.ownedByMsp
            ? t('autoconfig.ownedByMsp')
            : t('autoconfig.ownedByTenant', { tenant: template.data.tenantName })
        }
      />
      <TemplateEditor
        family={template.data.family}
        template={template.data}
        tenants={tenants.ok ? tenants.data.tenants : []}
        library={library.ok ? library.data.items : []}
      />
    </>
  );
}

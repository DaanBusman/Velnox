import { getTranslations } from 'next-intl/server';
import { Notice, PageHeader } from '@/components/ui/primitives';
import { TemplateList } from '@/components/autoconfig/template-list';
import { getSession, listTemplates, listTenants } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('nav.autoconfig') };
}

export default async function AutoconfigPage() {
  const [t, session, templates, tenants] = await Promise.all([
    getTranslations(),
    getSession(),
    listTemplates(),
    listTenants(),
  ]);
  const permissions = new Set(session?.user.permissions ?? []);

  return (
    <>
      <PageHeader title={t('nav.autoconfig')} description={t('autoconfig.subtitle')} />
      {templates.ok ? (
        <TemplateList
          templates={templates.data}
          tenants={tenants.ok ? tenants.data.tenants : []}
          canManage={permissions.has('autoconfig.manage')}
          canProvision={permissions.has('workloads.provision')}
        />
      ) : (
        <Notice tone={templates.code === 'authz.forbidden' ? 'warn' : 'error'}>
          {templates.code === 'authz.forbidden'
            ? t('common.requiresPermission', { permission: 'autoconfig.read' })
            : t('errors.generic')}
        </Notice>
      )}
    </>
  );
}

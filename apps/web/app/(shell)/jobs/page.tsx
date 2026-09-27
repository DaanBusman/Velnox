import { getTranslations } from 'next-intl/server';
import { JOB_STATUSES } from '@velnox/shared';
import { JobList } from '@/components/jobs/job-list';
import { Notice, PageHeader } from '@/components/ui/primitives';
import { refreshSeconds } from '@/lib/preferences';
import { getSession, listJobs, listTenants } from '@/lib/session';
import { resolveSelection, selectedTenantId } from '@/lib/tenant-selection';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('nav.jobs') };
}

interface Props {
  searchParams: Promise<{ status?: string }>;
}

export default async function JobsPage({ searchParams }: Props) {
  const { status: requested } = await searchParams;
  // Only a real status reaches the API; anything else is "all".
  const status = JOB_STATUSES.find((value) => value === requested) ?? null;

  const [t, session, tenants, selected, refresh] = await Promise.all([
    getTranslations(),
    getSession(),
    listTenants(),
    selectedTenantId(),
    refreshSeconds(),
  ]);

  const tenantId = resolveSelection(selected, tenants.ok ? tenants.data.tenants : []);
  const jobs = await listJobs({ status, tenantId });

  if (!jobs.ok) {
    return (
      <>
        <PageHeader title={t('nav.jobs')} />
        <Notice tone={jobs.code === 'authz.forbidden' ? 'warn' : 'error'}>
          {jobs.code === 'authz.forbidden'
            ? t('common.requiresPermission', { permission: 'jobs.read' })
            : t('errors.generic')}
        </Notice>
      </>
    );
  }

  const permissions = new Set(session?.user.permissions ?? []);

  return (
    <>
      <PageHeader title={t('nav.jobs')} description={t('job.subtitle')} />
      <JobList
        jobs={jobs.data.jobs}
        status={status}
        canSelftest={permissions.has('system.manage')}
        refreshSeconds={refresh}
      />
    </>
  );
}

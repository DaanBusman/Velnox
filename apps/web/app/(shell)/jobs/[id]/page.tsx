import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { JobDetail } from '@/components/jobs/job-detail';
import { Notice, PageHeader } from '@/components/ui/primitives';
import { getJob, getSession, listJobLogs } from '@/lib/session';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('nav.jobs') };
}

export default async function JobPage({ params }: Props) {
  const { id } = await params;
  const [t, session, job, logs] = await Promise.all([
    getTranslations(),
    getSession(),
    getJob(id),
    listJobLogs(id),
  ]);

  // A job in another tenant reads as one that does not exist, which is what
  // the API answers too.
  if (!job.ok && (job.code === 'job.not_found' || job.code === 'validation')) notFound();

  if (!job.ok) {
    return (
      <>
        <PageHeader title={t('nav.jobs')} />
        <Notice tone={job.code === 'authz.forbidden' ? 'warn' : 'error'}>
          {job.code === 'authz.forbidden'
            ? t('common.requiresPermission', { permission: 'jobs.read' })
            : t('errors.generic')}
        </Notice>
      </>
    );
  }

  /*
   * Which buttons to offer. A courtesy, like the sidebar: the grants here are
   * the account's anywhere, and the API checks each one at the job's own tenant
   * and refuses whatever this gets wrong.
   */
  const permissions = new Set(session?.user.permissions ?? []);

  return (
    <>
      <PageHeader title={t('nav.jobs')} description={job.data.id} />
      <JobDetail
        job={job.data}
        logs={logs.ok ? logs.data.lines : []}
        canCancel={permissions.has('jobs.cancel')}
        canApprove={permissions.has('jobs.approve')}
        canRetry={permissions.has('system.manage')}
      />
    </>
  );
}

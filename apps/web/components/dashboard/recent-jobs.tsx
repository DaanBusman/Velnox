'use client';

import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import type { JobSummary } from '@velnox/shared';
import { JobStatusBadge, useJobTypeLabel } from '@/components/jobs/primitives';

/** The last few jobs, each opening on its output. */
export function RecentJobs({ jobs }: { jobs: JobSummary[] }) {
  const t = useTranslations();
  const format = useFormatter();
  const typeLabel = useJobTypeLabel();
  if (jobs.length === 0) {
    return <p className="text-sm text-ink-muted">{t('dashboard.recentEmpty')}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-ink-muted">
            <th className="py-2 pr-3 font-medium">{t('dashboard.recentJob')}</th>
            <th className="py-2 pr-3 font-medium">{t('dashboard.recentCluster')}</th>
            <th className="py-2 pr-3 font-medium">{t('dashboard.recentStatus')}</th>
            <th className="py-2 font-medium">{t('dashboard.recentWhen')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {jobs.map((job) => (
            <tr key={job.id}>
              <td className="py-2 pr-3">
                <Link href={`/jobs/${job.id}`} className="text-accent underline">
                  {typeLabel(job.type)}
                </Link>
              </td>
              <td className="py-2 pr-3 text-ink-muted">{job.cluster?.name ?? '—'}</td>
              <td className="whitespace-nowrap py-2 pr-3">
                <JobStatusBadge status={job.status} />
              </td>
              <td className="whitespace-nowrap py-2 tabular-nums text-ink-muted">
                {format.dateTime(new Date(job.queuedAt), 'medium')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

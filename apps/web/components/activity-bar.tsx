'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import type { JobSummary } from '@velnox/shared';
import { TERMINAL_JOB_STATUSES } from '@velnox/shared';
import { apiGet } from '@/lib/client-api';
import { refreshSecondsInBrowser } from '@/lib/refresh-preference';
import { JobStatusBadge, ProgressBar, useJobTypeLabel } from '@/components/jobs/primitives';
import { useUploads } from '@/components/library/uploads-provider';

/** How far back finished jobs are listed. The owner's choice: half an hour. */
const RECENT_MS = 30 * 60_000;
const OPEN_KEY = 'velnox.activityBar.open';

/**
 * The running jobs, and uploads, at the bottom of every page.
 *
 * Jobs that are not finished, and those that finished in the last half hour,
 * read from the jobs API on the viewer's own refresh interval while the tab is
 * visible — the same list as Jobs, narrowed to what is happening now. A viewer
 * without `jobs.read` anywhere gets a refusal and sees only their uploads.
 *
 * Whether it is open is remembered in this browser only: a display preference,
 * like the refresh interval, with nothing to share.
 */
export function ActivityBar() {
  const t = useTranslations();
  const format = useFormatter();
  const typeLabel = useJobTypeLabel();
  const uploads = useUploads();

  const [open, setOpen] = useState(false);
  const [jobs, setJobs] = useState<JobSummary[] | null>(null);
  const [allowed, setAllowed] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    try {
      setOpen(window.localStorage.getItem(OPEN_KEY) === '1');
    } catch {
      // Storage can be unavailable; the bar then starts closed.
    }
  }, []);

  const toggle = () => {
    setOpen((value) => {
      try {
        window.localStorage.setItem(OPEN_KEY, value ? '0' : '1');
      } catch {
        // Not remembered; nothing else depends on it.
      }
      return !value;
    });
  };

  const load = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    const since = new Date(Date.now() - RECENT_MS).toISOString();
    void apiGet<{ jobs: JobSummary[] }>(
      `/jobs?active=true&finishedSince=${encodeURIComponent(since)}&limit=100`,
    ).then((result) => {
      if (!live) return;
      if (result.ok) {
        setAllowed(true);
        setJobs(result.data.jobs);
      } else if (result.error.status === 403) {
        setAllowed(false);
        setJobs([]);
      }
    });
    return () => {
      live = false;
    };
  }, [nonce]);

  useEffect(() => {
    const seconds = refreshSecondsInBrowser();
    if (seconds === 0) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, seconds * 1000);
    return () => clearInterval(timer);
  }, [load]);

  const list = jobs ?? [];
  const running = list.filter((job) => !TERMINAL_JOB_STATUSES.has(job.status));
  const finished = list
    .filter((job) => TERMINAL_JOB_STATUSES.has(job.status))
    .sort((a, b) => Date.parse(b.finishedAt ?? '') - Date.parse(a.finishedAt ?? ''));
  const uploadCount = uploads.active.length;

  // Nothing to show and nothing it could ever show: no bar at all.
  if (!allowed && uploadCount === 0 && uploads.finished.length === 0) return null;

  const when = (value: string | null) =>
    value ? format.relativeTime(new Date(value), { now: new Date() }) : '';

  const row = (job: JobSummary) => (
    <li key={job.id} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 px-4 py-2">
      <div className="min-w-0">
        <Link
          href={`/jobs/${job.id}`}
          className="truncate text-sm font-medium text-ink underline-offset-2 hover:underline"
        >
          {typeLabel(job.type)}
        </Link>
        <p className="truncate text-[11px] text-ink-muted">
          {job.tenantName}
          {job.currentStep && ` · ${job.currentStep}`}
          {' · '}
          {TERMINAL_JOB_STATUSES.has(job.status)
            ? when(job.finishedAt)
            : when(job.startedAt ?? job.queuedAt)}
        </p>
      </div>
      <JobStatusBadge status={job.status} />
      {!TERMINAL_JOB_STATUSES.has(job.status) && job.progressPct !== null && (
        <div className="col-span-2">
          <ProgressBar pct={job.progressPct} label={typeLabel(job.type)} />
        </div>
      )}
    </li>
  );

  return (
    <section
      aria-label={t('activity.title')}
      className="shrink-0 border-t border-line bg-surface shadow-[0_-1px_0_var(--velnox-border)]"
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex h-9 w-full items-center gap-3 px-4 text-left text-xs text-ink-muted hover:bg-surface-2"
      >
        <span className="font-medium text-ink">{t('activity.title')}</span>
        {allowed && (
          <span className={running.length > 0 ? 'text-accent' : undefined}>
            {t('activity.running', { count: running.length })}
          </span>
        )}
        {uploadCount > 0 && (
          <span className="text-accent">{t('activity.uploads', { count: uploadCount })}</span>
        )}
        <span className="ml-auto">{open ? t('activity.hide') : t('activity.show')}</span>
      </button>

      {open && (
        <div className="max-h-[40vh] overflow-y-auto border-t border-line">
          {(uploadCount > 0 || uploads.finished.length > 0) && (
            <div>
              <p className="bg-surface-2 px-4 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-muted">
                {t('activity.uploadsTitle')}
              </p>
              <ul className="divide-y divide-line/70">
                {uploads.active.map((upload) => (
                  <li key={upload.key} className="space-y-1 px-4 py-2">
                    <div className="flex items-center gap-3">
                      <span className="min-w-0 flex-1 truncate text-sm text-ink">
                        {upload.name}
                      </span>
                      <button
                        type="button"
                        className="text-xs text-ink-muted underline"
                        onClick={() => uploads.pause(upload.key)}
                      >
                        {t('library.pause')}
                      </button>
                    </div>
                    <ProgressBar
                      pct={Math.round((upload.sent / Math.max(1, upload.total)) * 100)}
                      label={upload.name}
                    />
                  </li>
                ))}
                {uploads.finished.map((done) => (
                  <li key={done.key} className="flex items-center gap-3 px-4 py-2 text-sm">
                    <span className="min-w-0 flex-1 truncate text-ink">{done.name}</span>
                    <span className={done.error ? 'text-xs text-error' : 'text-xs text-ok'}>
                      {done.error ? t('activity.uploadFailed') : t('activity.uploadDone')}
                    </span>
                    {done.jobId && (
                      <Link className="text-xs text-accent underline" href={`/jobs/${done.jobId}`}>
                        {t('library.followJob')}
                      </Link>
                    )}
                    <button
                      type="button"
                      className="text-xs text-ink-muted underline"
                      onClick={() => uploads.dismiss(done.key)}
                    >
                      {t('common.dismiss')}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {allowed && (
            <div>
              <div className="flex items-center gap-3 bg-surface-2 px-4 py-1">
                <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-muted">
                  {t('activity.jobsTitle')}
                </p>
                <button
                  type="button"
                  className="ml-auto text-[11px] text-ink-muted underline"
                  onClick={load}
                >
                  {t('common.refresh')}
                </button>
                <Link href="/jobs" className="text-[11px] text-accent underline">
                  {t('activity.allJobs')}
                </Link>
              </div>
              {jobs === null ? (
                <p className="px-4 py-3 text-xs text-ink-muted">{t('common.loading')}</p>
              ) : list.length === 0 ? (
                <p className="px-4 py-3 text-xs text-ink-muted">{t('activity.empty')}</p>
              ) : (
                <ul className="divide-y divide-line/70">
                  {running.map(row)}
                  {finished.length > 0 && (
                    <li className="bg-surface-2/60 px-4 py-1 text-[11px] text-ink-muted">
                      {t('activity.recent')}
                    </li>
                  )}
                  {finished.map(row)}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

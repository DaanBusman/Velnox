'use client';

import { useTranslations } from 'next-intl';
import type { JobEventMessage, JobStatus, JobStepStatus } from '@velnox/shared';
import { StatusBadge, type StatusTone } from '@/components/ui/primitives';

/**
 * Small pieces shared by the job list and the job page.
 *
 * Status names come from `status.job.*`, which are glossary terms
 * (packages/i18n/glossary.csv): "Actief", not "Bezig"; "Wacht op goedkeuring",
 * not "In afwachting". A status is the one word an operator scans a list for, so
 * it has to be the same word everywhere.
 */

const JOB_TONE: Record<JobStatus, StatusTone> = {
  QUEUED: 'neutral',
  PREFLIGHT: 'neutral',
  WAITING_APPROVAL: 'warn',
  RUNNING: 'unknown',
  VALIDATING: 'unknown',
  SUCCEEDED: 'ok',
  PARTIALLY_SUCCEEDED: 'warn',
  FAILED: 'error',
  ROLLED_BACK: 'warn',
  CANCELLED: 'neutral',
};

const STEP_TONE: Record<JobStepStatus, StatusTone> = {
  PENDING: 'neutral',
  RUNNING: 'unknown',
  SKIPPED: 'neutral',
  SUCCEEDED: 'ok',
  FAILED: 'error',
  ROLLED_BACK: 'warn',
};

export function JobStatusBadge({ status }: { status: JobStatus }) {
  const t = useTranslations();
  return <StatusBadge tone={JOB_TONE[status]}>{t(`status.job.${status.toLowerCase()}`)}</StatusBadge>;
}

export function StepStatusBadge({ status }: { status: JobStepStatus }) {
  const t = useTranslations();
  return (
    <StatusBadge tone={STEP_TONE[status]}>{t(`status.jobStep.${status.toLowerCase()}`)}</StatusBadge>
  );
}

/** A thin bar. Absent rather than at zero when there is no progress to report. */
export function ProgressBar({ pct, label }: { pct: number | null; label: string }) {
  if (pct === null) return null;
  const bounded = Math.max(0, Math.min(100, pct));
  return (
    <div className="flex items-center gap-2">
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={bounded}
        className="h-1.5 w-full min-w-24 overflow-hidden rounded-full bg-surface-3"
      >
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-500 ease-out"
          style={{ width: `${bounded}%` }}
        />
      </div>
      <span className="w-9 shrink-0 text-right font-mono text-[11px] tabular-nums text-ink-muted">
        {bounded}%
      </span>
    </div>
  );
}

/** `system.selftest` → "Self-test"; an unknown type shows as itself. */
export function useJobTypeLabel(): (type: string) => string {
  const t = useTranslations();
  return (type) => {
    const key = `job.types.${type.split('.').pop() ?? type}`;
    return t.has(key) ? t(key) : type;
  };
}

/**
 * An event in the reader's language.
 *
 * The event carries a stable key and English diagnostic text; the key is what
 * gets translated, filled from the event's data. An event the interface does
 * not know yet — a newer worker, say — falls back to its English message
 * rather than disappearing.
 */
export function useEventText(): (event: JobEventMessage) => string {
  const t = useTranslations();
  return (event) => {
    const key = `job.event.${event.key.replace(/\./g, '_')}`;
    if (!t.has(key)) return event.message;
    return t(key, {
      by: String(event.data.by ?? ''),
      step: event.stepKey ?? '',
      pct: String(event.data.stepPct ?? ''),
    });
  };
}

export const RETRYABLE_STATUSES: ReadonlySet<JobStatus> = new Set([
  'FAILED',
  'CANCELLED',
  'ROLLED_BACK',
]);

/** Seconds between two instants, or null when the job has not started. */
export function durationSeconds(startedAt: string | null, finishedAt: string | null): number | null {
  if (!startedAt) return null;
  const end = finishedAt ? Date.parse(finishedAt) : Date.now();
  return Math.max(0, Math.round((end - Date.parse(startedAt)) / 1000));
}

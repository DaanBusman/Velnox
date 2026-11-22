'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import {
  isTerminal,
  type JobDetail as Job,
  type JobEventMessage,
  type JobLogLine,
  type JobStatus,
} from '@velnox/shared';
import { apiGet, apiPost, type ApiFailure } from '@/lib/client-api';
import { useApiError } from '@/lib/use-api-error';
import { useClock } from '@/lib/use-clock';
import { Button, FormError, TextInput } from '@/components/ui/form';
import { Card, KeyValue, Mono, Notice, StatusBadge } from '@/components/ui/primitives';
import {
  JobStatusBadge,
  ProgressBar,
  RETRYABLE_STATUSES,
  StepStatusBadge,
  durationSeconds,
  useEventText,
  useJobTypeLabel,
} from './primitives';
import { messageValues } from '@/lib/message-values';

/**
 * One job, live.
 *
 * The page renders from the server and then opens the event stream from the
 * beginning, so the event list is complete and ordered by sequence number
 * however the page was reached. Progress and status are applied from each event
 * as it arrives. Anything structural — a step starting or finishing, a gate, a
 * final state — triggers a re-read of the page, because the step list, the
 * approvals and the output are the server's to render and there is no point
 * reconstructing them from events in the browser.
 *
 * The stream closes itself when the job finishes (`done`). The browser's
 * EventSource reconnects on its own after anything else, and the server resumes
 * from the last sequence number it saw.
 */
export function JobDetail({
  job,
  logs,
  canCancel,
  canApprove,
  canRetry,
  renderedAt,
}: {
  job: Job;
  logs: JobLogLine[];
  canCancel: boolean;
  canApprove: boolean;
  canRetry: boolean;
  /** When the server rendered this page; see `useClock`. */
  renderedAt: string;
}) {
  const t = useTranslations();
  const format = useFormatter();
  const router = useRouter();
  const typeLabel = useJobTypeLabel();
  const eventText = useEventText();
  const describeError = useApiError();
  const now = useClock(renderedAt);

  const [events, setEvents] = useState<JobEventMessage[]>([]);
  const [liveStatus, setLiveStatus] = useState<JobStatus>(job.status);
  const [livePct, setLivePct] = useState<number | null>(job.progressPct);
  const [connection, setConnection] = useState<'live' | 'reconnecting' | 'closed'>(
    isTerminal(job.status) ? 'closed' : 'live',
  );
  const [showProgress, setShowProgress] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [note, setNote] = useState('');
  const [liveLogs, setLiveLogs] = useState<JobLogLine[]>(logs);
  const lastStatus = useRef<JobStatus>(job.status);

  // A re-read of the page brings the server's lines; keep whatever the tail
  // already added on top of them.
  useEffect(() => setLiveLogs((current) => mergeLines(current, logs)), [logs]);

  // The server-rendered status is newer than the live one after a refresh.
  useEffect(() => setLiveStatus(job.status), [job.status]);
  useEffect(() => setLivePct(job.progressPct), [job.progressPct]);

  const refreshSoon = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = () => {
    if (refreshSoon.current) clearTimeout(refreshSoon.current);
    refreshSoon.current = setTimeout(() => router.refresh(), 250);
  };

  useEffect(() => {
    const source = new EventSource(`/api/v1/jobs/${job.id}/stream`);
    const seen = new Set<number>();

    source.addEventListener('job', (message) => {
      const event = JSON.parse((message as MessageEvent<string>).data) as JobEventMessage;
      if (seen.has(event.seq)) return;
      seen.add(event.seq);

      setEvents((current) => [...current, event].sort((a, b) => a.seq - b.seq));
      setLiveStatus(event.status);
      if (event.progressPct !== null) setLivePct(event.progressPct);
      setConnection('live');

      // Anything structural re-reads the page — and so does any change of
      // status, whatever event carried it, so the steps, the output and the
      // buttons on screen always belong to the status the badge shows.
      const statusChanged = event.status !== lastStatus.current;
      lastStatus.current = event.status;
      if (event.key !== 'step.progress' || statusChanged) scheduleRefresh();
    });

    source.addEventListener('done', () => {
      source.close();
      setConnection('closed');
      scheduleRefresh();
    });

    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) setConnection('closed');
      else setConnection('reconnecting');
    };

    return () => {
      source.close();
      if (refreshSoon.current) clearTimeout(refreshSoon.current);
    };
    // One stream per job; re-rendering must not reopen it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.id]);

  /*
   * The output, live.
   *
   * Lines are written by the worker as a step produces them, and they carry no
   * event: before 0.7.19 the output pane showed what was there when the page
   * was last read, and a step printing for ten minutes looked like one that
   * printed nothing. While the job runs, new lines are fetched every two
   * seconds from the last one seen — never the whole log again — and not at
   * all in a hidden tab. The page's own re-read when the job finishes brings
   * the last of them.
   */
  const lastLogId = liveLogs.length > 0 ? liveLogs[liveLogs.length - 1]?.id : undefined;
  const lastLogRef = useRef(lastLogId);
  lastLogRef.current = lastLogId;
  const tailing = !isTerminal(liveStatus);
  useEffect(() => {
    if (!tailing) return;
    let stopped = false;
    let busy = false;
    const tick = async () => {
      if (busy || document.visibilityState !== 'visible') return;
      busy = true;
      const after = lastLogRef.current;
      const result = await apiGet<{ lines: JobLogLine[] }>(
        `/jobs/${job.id}/logs?limit=500${after ? `&after=${after}` : ''}`,
      );
      busy = false;
      if (!stopped && result.ok && result.data.lines.length > 0) {
        setLiveLogs((current) => mergeLines(current, result.data.lines));
      }
    };
    const timer = setInterval(() => void tick(), LOG_TAIL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [tailing, job.id]);

  const logPane = useRef<HTMLPreElement>(null);
  const eventPane = useRef<HTMLOListElement>(null);

  const visibleEvents = useMemo(
    () => (showProgress ? events : events.filter((event) => event.key !== 'step.progress')),
    [events, showProgress],
  );

  useStickToBottom(logPane, liveLogs.length);
  useStickToBottom(eventPane, visibleEvents.length);

  const pendingApproval = job.approvals.find((approval) => approval.decision === null);
  const active = !isTerminal(liveStatus);
  const seconds = durationSeconds(job.startedAt, job.finishedAt, now);

  async function act(key: string, path: string, body?: unknown) {
    setPending(key);
    setFailure(null);
    const result = await apiPost<Job>(path, body);
    setPending(null);
    if (!result.ok) {
      setFailure(result.error);
      return;
    }
    if (key === 'retry') {
      router.push(`/jobs/${result.data.id}`);
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-4">
      {failure && <FormError>{describeError(failure)}</FormError>}

      <Card
        title={typeLabel(job.type)}
        description={job.cluster ? t('job.onCluster', { cluster: job.cluster.name }) : (job.concurrencyKey ?? job.id)}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {connection !== 'closed' && (
              <StatusBadge tone={connection === 'live' ? 'ok' : 'warn'}>
                {connection === 'live' ? t('job.live') : t('job.reconnecting')}
              </StatusBadge>
            )}
            {canCancel && active && !job.cancelRequested && (
              <Button
                variant="secondary"
                pending={pending === 'cancel'}
                onClick={() => void act('cancel', `/jobs/${job.id}/cancel`)}
                title={t('job.cancelHint')}
              >
                {t('job.cancel')}
              </Button>
            )}
            {canRetry && RETRYABLE_STATUSES.has(liveStatus) && (
              <Button
                variant="secondary"
                pending={pending === 'retry'}
                onClick={() => void act('retry', `/jobs/${job.id}/retry`)}
              >
                {t('job.retry')}
              </Button>
            )}
          </div>
        }
      >
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <JobStatusBadge status={liveStatus} />
            <div className="min-w-48 flex-1">
              <ProgressBar pct={livePct} label={t('job.progress')} />
            </div>
          </div>

          {job.cancelRequested && active && <Notice tone="warn">{t('job.cancelRequested')}</Notice>}

          {job.errorCode && (
            <Notice tone="error" title={t('job.errorTitle')}>
              <p>
                {t.has(`errors.${job.errorCode}`)
                  ? t(`errors.${job.errorCode}`, messageValues(job.errorParams))
                  : t('errors.generic')}
              </p>
              {job.errorDetail && (
                <p className="mt-2 font-mono text-[11px] text-ink-muted">
                  {t('job.errorDetail')}: {job.errorDetail}
                </p>
              )}
            </Notice>
          )}

          <dl>
            {job.cluster && (
              <KeyValue label={t('job.cluster')}>
                <Link href={`/clusters/${job.cluster.id}`} className="text-accent underline underline-offset-2">
                  {job.cluster.name}
                </Link>
              </KeyValue>
            )}
            <KeyValue label={t('job.colTenant')}>{job.tenantName}</KeyValue>
            <KeyValue label={t('job.colBy')}>{job.createdBy?.email ?? '—'}</KeyValue>
            <KeyValue label={t('job.queuedAt')}>{format.dateTime(new Date(job.queuedAt), 'medium')}</KeyValue>
            <KeyValue label={t('job.startedAt')}>
              {job.startedAt ? format.dateTime(new Date(job.startedAt), 'medium') : '—'}
            </KeyValue>
            <KeyValue label={t('job.finishedAt')}>
              {job.finishedAt ? format.dateTime(new Date(job.finishedAt), 'medium') : '—'}
            </KeyValue>
            <KeyValue label={t('job.colDuration')}>
              {seconds === null ? '—' : t('job.durationSeconds', { seconds })}
            </KeyValue>
            {job.parentJobId && (
              <KeyValue label={t('job.retryOf')}>
                <Link href={`/jobs/${job.parentJobId}`} className="text-accent underline underline-offset-2">
                  <Mono>{job.parentJobId.slice(0, 8)}</Mono>
                </Link>
              </KeyValue>
            )}
            {job.retries.length > 0 && (
              <KeyValue label={t('job.retriedAs')}>
                <span className="flex flex-wrap gap-2">
                  {job.retries.map((retry) => (
                    <Link key={retry.id} href={`/jobs/${retry.id}`} className="text-accent underline underline-offset-2">
                      <Mono>{retry.id.slice(0, 8)}</Mono>
                    </Link>
                  ))}
                </span>
              </KeyValue>
            )}
          </dl>
        </div>
      </Card>

      {pendingApproval && liveStatus === 'WAITING_APPROVAL' && (
        <Card title={t('job.approvalTitle')} description={t('job.approvalPrompt')}>
          <div className="space-y-3">
            <p className="text-sm text-ink">{pendingApproval.reason}</p>
            <p className="text-xs text-ink-muted">
              {t('job.approvalNeeds', { permission: pendingApproval.requiredPermission })}
            </p>
            {pendingApproval.requireDifferentApprover && (
              <Notice tone="warn">{t('job.approvalFourEyes')}</Notice>
            )}
            {Object.keys(pendingApproval.changeSet).length > 0 && (
              <div>
                <p className="mb-1 text-xs font-medium text-ink-muted">{t('job.changeSet')}</p>
                <pre className="overflow-x-auto rounded border border-line bg-surface-2 p-2 font-mono text-[11px] text-ink">
                  {JSON.stringify(pendingApproval.changeSet, null, 2)}
                </pre>
              </div>
            )}
            {canApprove && (
              <>
                <TextInput
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder={t('job.note')}
                  aria-label={t('job.note')}
                  maxLength={2000}
                />
                <div className="flex gap-2">
                  <Button
                    pending={pending === 'approve'}
                    onClick={() => void act('approve', `/jobs/${job.id}/approve`, { note: note || null })}
                  >
                    {t('job.approve')}
                  </Button>
                  <Button
                    variant="secondary"
                    pending={pending === 'reject'}
                    onClick={() => void act('reject', `/jobs/${job.id}/reject`, { note: note || null })}
                  >
                    {t('job.reject')}
                  </Button>
                </div>
              </>
            )}
          </div>
        </Card>
      )}

      <Card title={t('job.steps')} bodyClassName="">
        <ol className="divide-y divide-line">
          {job.steps.map((step) => (
            <li key={step.key} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <span className="w-6 text-right font-mono text-xs text-ink-muted">{step.sequence}</span>
              <span className="min-w-32 flex-1 font-mono text-xs text-ink">{step.key}</span>
              <StepStatusBadge status={step.status} />
              {step.error && <span className="w-full pl-9 font-mono text-[11px] text-error">{step.error}</span>}
            </li>
          ))}
        </ol>
      </Card>

      {job.approvals.some((approval) => approval.decision !== null) && (
        <Card title={t('job.approvalTitle')} bodyClassName="">
          <ul className="divide-y divide-line">
            {job.approvals
              .filter((approval) => approval.decision !== null)
              .map((approval) => (
                <li key={approval.id} className="px-4 py-2.5 text-sm">
                  <span className="font-mono text-xs text-ink-muted">{approval.stepKey}</span>{' '}
                  {t('job.approvalDecided', {
                    decision: approval.decision ?? 'REJECTED',
                    by: approval.decidedBy ?? '—',
                  })}
                  {approval.decisionNote && (
                    <span className="block text-xs text-ink-muted">“{approval.decisionNote}”</span>
                  )}
                </li>
              ))}
          </ul>
        </Card>
      )}

      <Card
        title={t('job.events')}
        bodyClassName=""
        actions={
          <label className="flex items-center gap-2 text-xs text-ink-muted">
            <input
              type="checkbox"
              checked={showProgress}
              onChange={(event) => setShowProgress(event.target.checked)}
            />
            {t('job.showProgress')}
          </label>
        }
      >
        <ol ref={eventPane} className="max-h-[50vh] divide-y divide-line/70 overflow-auto" aria-live="polite">
          {visibleEvents.map((event) => (
            <li key={event.seq} className="flex gap-3 px-4 py-1.5 text-xs">
              <span className="w-8 shrink-0 text-right font-mono text-ink-muted">{event.seq}</span>
              <span className="w-20 shrink-0 font-mono text-ink-muted">
                {format.dateTime(new Date(event.at), { timeStyle: 'medium' })}
              </span>
              <span
                className={
                  event.level === 'ERROR'
                    ? 'text-error'
                    : event.level === 'WARN'
                      ? 'text-warn'
                      : 'text-ink'
                }
              >
                {eventText(event)}
              </span>
            </li>
          ))}
        </ol>
      </Card>

      <Card title={t('job.logs')} bodyClassName="">
        {liveLogs.length === 0 ? (
          <p className="px-4 py-6 text-sm text-ink-muted">{t('job.noLogs')}</p>
        ) : (
          <pre
            ref={logPane}
            className="max-h-[40vh] overflow-auto px-4 py-3 font-mono text-[11px] leading-relaxed text-ink"
          >
            {liveLogs
              .map((line) => `${line.stream === 'STDERR' ? '! ' : '  '}${line.content}${line.truncated ? ' …' : ''}`)
              .join('\n')}
          </pre>
        )}
      </Card>

      <Card title={t('job.params')}>
        <pre className="overflow-x-auto font-mono text-[11px] text-ink">{JSON.stringify(job.params, null, 2)}</pre>
      </Card>
    </div>
  );
}

/** How often a running job's output is asked for new lines. */
const LOG_TAIL_MS = 2_000;

/** Two sets of output lines as one, in order, each line once. */
function mergeLines(current: JobLogLine[], incoming: JobLogLine[]): JobLogLine[] {
  if (incoming.length === 0) return current;
  const byId = new Map(current.map((line) => [line.id, line]));
  for (const line of incoming) byId.set(line.id, line);
  return [...byId.values()].sort((a, b) => {
    const left = BigInt(a.id);
    const right = BigInt(b.id);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/**
 * Keep a scrolling pane at its newest line as lines arrive — unless the reader
 * scrolled up to read something, which a pane that jumps back down would take
 * away from them. Whether it is at the bottom is decided before the new lines
 * render, by the last scroll.
 */
function useStickToBottom(ref: RefObject<HTMLElement | null>, count: number): void {
  const atBottom = useRef(true);
  const present = count > 0;
  useEffect(() => {
    const pane = ref.current;
    if (!pane) return;
    const onScroll = () => {
      atBottom.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 24;
    };
    pane.addEventListener('scroll', onScroll, { passive: true });
    return () => pane.removeEventListener('scroll', onScroll);
  }, [ref, present]);
  useLayoutEffect(() => {
    const pane = ref.current;
    if (pane && atBottom.current) pane.scrollTop = pane.scrollHeight;
  }, [ref, count]);
}

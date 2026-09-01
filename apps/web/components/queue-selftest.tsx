'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { PingJobAcceptedResponse, PingJobStatusResponse } from '@velnox/shared';
import { Card, Notice, StatusBadge, type StatusTone } from '@/components/ui/primitives';

const TERMINAL: PingJobStatusResponse['state'][] = ['completed', 'failed', 'unknown'];

/** Queue states mapped onto the shared job vocabulary the rest of the UI uses. */
const STATE_LABEL: Record<PingJobStatusResponse['state'], string> = {
  waiting: 'status.job.queued',
  delayed: 'status.job.queued',
  paused: 'status.job.queued',
  active: 'status.job.running',
  completed: 'status.job.succeeded',
  failed: 'status.job.failed',
  unknown: 'status.health.unknown',
};

const STATE_TONE: Record<PingJobStatusResponse['state'], StatusTone> = {
  waiting: 'neutral',
  active: 'warn',
  delayed: 'neutral',
  paused: 'neutral',
  completed: 'ok',
  failed: 'error',
  unknown: 'unknown',
};

/**
 * Queue self-test.
 *
 * Client-side because it polls a job it just submitted. Requests go to the same
 * origin — the reverse proxy routes /api/v1 to the API — so the browser needs no
 * token and no cross-origin configuration.
 *
 * This is a Phase 1 diagnostic, and it says so. Phase 5 replaces it with the
 * real job system.
 */
export function QueueSelfTest({ enabled }: { enabled: boolean }) {
  const t = useTranslations();
  const [status, setStatus] = useState<PingJobStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const poll = useCallback(
    async (jobId: string) => {
      try {
        const response = await fetch(`/api/v1/system/selftest/queue/${jobId}`, {
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const next = (await response.json()) as PingJobStatusResponse;
        setStatus(next);
        if (TERMINAL.includes(next.state)) {
          stopPolling();
          setBusy(false);
        }
      } catch {
        stopPolling();
        setBusy(false);
        setError(t('selftest.error'));
      }
    },
    [stopPolling, t],
  );

  const run = useCallback(async () => {
    setError(null);
    setStatus(null);
    setBusy(true);
    stopPolling();

    try {
      const response = await fetch('/api/v1/system/selftest/queue', { method: 'POST' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const accepted = (await response.json()) as PingJobAcceptedResponse;
      await poll(accepted.jobId);
      pollRef.current = setInterval(() => void poll(accepted.jobId), 600);
    } catch {
      setBusy(false);
      setError(t('selftest.error'));
    }
  }, [poll, stopPolling, t]);

  return (
    <Card title={t('selftest.title')} description={t('selftest.description')}>
      {!enabled ? (
        <Notice tone="neutral">{t('selftest.disabled')}</Notice>
      ) : (
        <div className="space-y-3">
          <button
            type="button"
            onClick={() => void run()}
            disabled={busy}
            className="h-8 rounded bg-accent px-3 text-xs font-medium text-accent-contrast disabled:opacity-60"
          >
            {busy ? t('selftest.running') : t('selftest.run')}
          </button>

          {error && <Notice tone="error">{error}</Notice>}

          {status && (
            <div className="space-y-2 rounded border border-line bg-surface-2 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge tone={STATE_TONE[status.state]}>
                  {t(STATE_LABEL[status.state])}
                </StatusBadge>
                <span className="font-mono text-xs text-ink-muted">
                  {t('selftest.jobId', { id: status.jobId })}
                </span>
              </div>

              {status.state === 'completed' && status.result && (
                <p className="text-xs text-ink">
                  {t('selftest.succeeded', {
                    host: status.result.processedBy,
                    ms: status.result.durationMs,
                  })}
                </p>
              )}

              {status.state === 'failed' && (
                <p className="text-xs text-error">
                  {t('selftest.failed', { reason: status.failedReason ?? '' })}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

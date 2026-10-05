'use client';

import { useCallback, useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import type { CheckStatus, ReadinessResponse } from '@velnox/shared';
import { Button } from '@/components/ui/form';
import { Card, Notice, StatusBadge, type StatusTone } from '@/components/ui/primitives';
import { refreshSecondsInBrowser } from '@/lib/refresh-preference';
import { PanelLoading } from './panel-state';

const TONE: Record<CheckStatus, StatusTone> = {
  ok: 'ok',
  degraded: 'warn',
  down: 'error',
};

const CHECK_LABEL_KEY: Record<string, string> = {
  database: 'system.checks.database',
  redis: 'system.checks.redis',
  worker: 'system.checks.worker',
};

/**
 * Live readiness of this installation.
 *
 * Lives in Server management rather than on the dashboard: it describes the
 * Velnox installation itself, which is the subject of that window and not of a
 * screen about someone's fleet. It is also the acceptance evidence that the six
 * services are actually talking to each other rather than merely running.
 *
 * Read in the browser rather than through the page, because this window opens
 * over whatever you were doing: a server-rendered readiness would be as old as
 * the page behind it, and a stale "everything is fine" is the one answer this
 * card must never give.
 *
 * Not `useApiResource`: `/readyz` sits outside the `/api/v1` prefix on purpose
 * (it is an infrastructure probe, not versioned API), and it answers 503 with
 * the report still in the body. Treating that 503 as a failure would replace
 * the reason the installation is down with "something went wrong".
 *
 * Read again on the viewer's own refresh interval while the tab is visible,
 * and on demand. It used to be read once, when the tab opened — so a worker
 * that came back stayed "down" on screen until the window was closed.
 */
function useReadiness(): {
  loading: boolean;
  refreshing: boolean;
  readiness: ReadinessResponse | null;
  checkedAt: Date | null;
  refresh: () => void;
} {
  const [state, setState] = useState<{
    loading: boolean;
    readiness: ReadinessResponse | null;
    checkedAt: Date | null;
  }>({ loading: true, readiness: null, checkedAt: null });
  const [refreshing, setRefreshing] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    setRefreshing(true);

    void (async () => {
      let readiness: ReadinessResponse | null = null;
      try {
        const response = await fetch('/readyz', {
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
          cache: 'no-store',
        });
        // 200 and 503 both carry the report; anything else does not.
        if (response.ok || response.status === 503) {
          readiness = (await response.json()) as ReadinessResponse;
        }
      } catch {
        readiness = null;
      }
      if (!live) return;
      setState({ loading: false, readiness, checkedAt: new Date() });
      setRefreshing(false);
    })();

    return () => {
      live = false;
    };
  }, [nonce]);

  useEffect(() => {
    const seconds = refreshSecondsInBrowser();
    if (seconds === 0) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') setNonce((n) => n + 1);
    }, seconds * 1000);
    return () => clearInterval(timer);
  }, []);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, refreshing, refresh };
}

export function StatusPanel() {
  const t = useTranslations();
  const format = useFormatter();
  const { loading, refreshing, readiness, checkedAt, refresh } = useReadiness();

  if (loading) return <PanelLoading />;

  const refreshButton = (
    <Button variant="secondary" className="h-8 text-xs" pending={refreshing} onClick={refresh}>
      {t('common.refresh')}
    </Button>
  );

  if (!readiness) {
    return (
      <Card title={t('system.title')} description={t('system.subtitle')} actions={refreshButton}>
        <Notice tone="error">{t('system.unreachable')}</Notice>
      </Card>
    );
  }

  const { migrations } = readiness;

  return (
    <Card
      title={t('system.title')}
      description={t('system.subtitle')}
      actions={
        <div className="flex items-center gap-2">
          <StatusBadge tone={TONE[readiness.status]}>
            {t(`status.dependency.${readiness.status}`)}
          </StatusBadge>
          {refreshButton}
        </div>
      }
    >
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs text-ink-muted">
            <th scope="col" className="py-1.5 pr-4 font-medium">
              {t('system.checkName')}
            </th>
            <th scope="col" className="py-1.5 pr-4 font-medium">
              {t('system.checkStatus')}
            </th>
            <th scope="col" className="py-1.5 font-medium">
              {t('system.checkDetail')}
            </th>
          </tr>
        </thead>
        <tbody>
          {readiness.checks.map((check) => {
            const labelKey = CHECK_LABEL_KEY[check.name];
            return (
              <tr key={check.name} className="border-b border-line last:border-b-0">
                <th scope="row" className="py-2 pr-4 text-left font-normal text-ink">
                  {labelKey ? t(labelKey) : check.name}
                </th>
                <td className="py-2 pr-4">
                  <StatusBadge tone={TONE[check.status]}>
                    {t(`status.dependency.${check.status}`)}
                  </StatusBadge>
                </td>
                <td className="py-2 text-xs text-ink-muted">
                  {check.detail
                    ? t(`system.detail.${check.detail.code}`, check.detail.params)
                    : check.latencyMs !== undefined
                      ? t('system.latency', { ms: check.latencyMs })
                      : ''}
                </td>
              </tr>
            );
          })}

          <tr>
            <th scope="row" className="py-2 pr-4 text-left font-normal text-ink">
              {t('system.checks.migrations')}
            </th>
            <td className="py-2 pr-4">
              <StatusBadge tone={TONE[migrations.status]}>
                {t(`status.dependency.${migrations.status}`)}
              </StatusBadge>
            </td>
            <td className="py-2 text-xs text-ink-muted">
              {t('system.migrationsSummary', {
                applied: migrations.applied,
                expected: migrations.expected,
              })}
              {migrations.pending.length > 0 && (
                <span className="ml-2 text-error">
                  {t('system.migrationsPending', { names: migrations.pending.join(', ') })}
                </span>
              )}
              {migrations.unknown.length > 0 && (
                <span className="ml-2 text-warn">
                  {t('system.migrationsUnknown', { names: migrations.unknown.join(', ') })}
                </span>
              )}
            </td>
          </tr>
        </tbody>
      </table>

      <p className="mt-3 text-xs text-ink-muted">{t('system.workerHint')}</p>
      {checkedAt && (
        <p className="mt-1 text-xs text-ink-muted">
          {t('system.checkedAt', { time: format.dateTime(checkedAt, { timeStyle: 'medium' }) })}
        </p>
      )}
    </Card>
  );
}

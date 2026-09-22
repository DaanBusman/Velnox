'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { CheckStatus, ReadinessResponse } from '@velnox/shared';
import { Card, Notice, StatusBadge, type StatusTone } from '@/components/ui/primitives';
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
 */
function useReadiness(): { loading: boolean; readiness: ReadinessResponse | null } {
  const [state, setState] = useState<{ loading: boolean; readiness: ReadinessResponse | null }>({
    loading: true,
    readiness: null,
  });

  useEffect(() => {
    let live = true;

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
      if (live) setState({ loading: false, readiness });
    })();

    return () => {
      live = false;
    };
  }, []);

  return state;
}

export function StatusPanel() {
  const t = useTranslations();
  const { loading, readiness } = useReadiness();

  if (loading) return <PanelLoading />;

  if (!readiness) {
    return (
      <Card title={t('system.title')} description={t('system.subtitle')}>
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
        <StatusBadge tone={TONE[readiness.status]}>
          {t(`status.dependency.${readiness.status}`)}
        </StatusBadge>
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
          {readiness.checks.map((check) => (
            <tr key={check.name} className="border-b border-line last:border-b-0">
              <th scope="row" className="py-2 pr-4 text-left font-normal text-ink">
                {CHECK_LABEL_KEY[check.name] ? t(CHECK_LABEL_KEY[check.name]) : check.name}
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
          ))}

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
    </Card>
  );
}

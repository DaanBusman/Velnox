import { getTranslations } from 'next-intl/server';
import type { CheckStatus, ReadinessResponse } from '@velnox/shared';
import { Card, Notice, StatusBadge, type StatusTone } from '@/components/ui/primitives';

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
 * Live readiness of this installation, read server-side from /readyz.
 *
 * This is the one card on the Phase 1 dashboard backed by real data, and it is
 * the acceptance evidence that the six services are actually talking to each
 * other rather than merely running.
 */
export async function SystemStatus({ readiness }: { readiness: ReadinessResponse | null }) {
  const t = await getTranslations();

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

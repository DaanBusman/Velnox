import { getTranslations } from 'next-intl/server';
import { SystemStatus } from '@/components/system-status';
import { Card, Notice, PageHeader } from '@/components/ui/primitives';
import { tryGetReadiness } from '@/lib/api';
import { getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** Dashboard tiles from the brief, each labelled with the phase that fills it. */
const TILES = [
  { key: 'tenants', phase: 3 },
  { key: 'clusters', phase: 4 },
  { key: 'nodes', phase: 4 },
  { key: 'nodesNeedingUpdates', phase: 6 },
  { key: 'upgradeBlockers', phase: 9 },
  { key: 'unhealthyClusters', phase: 4 },
  { key: 'runningJobs', phase: 5 },
  { key: 'recentFailures', phase: 5 },
] as const;

export default async function DashboardPage() {
  const [t, readiness, session] = await Promise.all([
    getTranslations(),
    tryGetReadiness(),
    getSession(),
  ]);

  // Recommended only where it is genuinely a choice. Repeating the advice at
  // someone whose installation already compels a second factor is noise, and
  // noise is how a notice stops being read.
  const mfaPolicy = session?.user.mfa.policy ?? 'OPTIONAL';

  return (
    <>
      <PageHeader title={t('dashboard.title')} description={t('dashboard.subtitle')} />

      <div className="space-y-5">
        <Notice tone="warn" title={t('dashboard.phaseNoticeTitle')}>
          <p>{t('dashboard.phaseNoticeBody')}</p>
          {mfaPolicy === 'OPTIONAL' && (
            <p className="mt-2 font-medium text-ink">{t('auth.mfaRecommendedNotice')}</p>
          )}
        </Notice>

        <SystemStatus readiness={readiness} />

        {/*
          Counters are shown at zero with the phase that will populate them, rather
          than with invented numbers. An MSP tool that displays plausible fiction
          is worse than one that displays nothing.
        */}
        <Card title={t('dashboard.subtitle')}>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {TILES.map((tile) => (
              <li key={tile.key} className="rounded border border-line bg-surface-2 px-3 py-2.5">
                <p className="truncate text-xs text-ink-muted">{t(`dashboard.tiles.${tile.key}`)}</p>
                <p className="mt-1 font-mono text-xl leading-none text-ink-muted/60">—</p>
                <p className="mt-1.5 text-[10px] uppercase tracking-wide text-ink-muted">
                  {t('dashboard.tileUnavailable', { phase: tile.phase })}
                </p>
              </li>
            ))}
          </ul>
        </Card>

      </div>
    </>
  );
}

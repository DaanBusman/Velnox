import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ACTIVE_JOB_STATUSES } from '@velnox/shared';
import { Card, Notice, PageHeader } from '@/components/ui/primitives';
import { tryGetSystemInfo } from '@/lib/api';
import { getSession, listClusters, listJobs, listNodes, listTenants } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Dashboard tiles from the brief, each labelled with the phase that fills it.
 *
 * A tile whose phase is done shows a real count; one whose phase is still ahead
 * shows a dash and says when. For three phases this page did the second thing
 * for every tile — "available from phase 3" on a phase 4 build, beside data the
 * product had had for weeks — which is the same fiction the dashes exist to
 * avoid, told the other way round.
 */
const TILES = [
  { key: 'tenants', phase: 3, href: '/tenants' },
  { key: 'clusters', phase: 4, href: '/clusters' },
  { key: 'nodes', phase: 4, href: '/nodes' },
  { key: 'nodesNeedingUpdates', phase: 6, href: null },
  { key: 'upgradeBlockers', phase: 9, href: null },
  { key: 'unhealthyClusters', phase: 4, href: '/clusters' },
  { key: 'runningJobs', phase: 5, href: '/jobs' },
  { key: 'recentFailures', phase: 5, href: '/jobs?status=FAILED' },
] as const;

type TileKey = (typeof TILES)[number]['key'];

/**
 * The phase this build has completed, read from its version: below 1.0.0 the
 * minor number *is* the phase (scripts/version.mjs). A constant here would be
 * right until the next phase and wrong after it — which is exactly how the
 * tiles came to say "available from phase 3" on a phase 4 build.
 *
 * Unknown is 0: every tile shows a dash rather than a number the page cannot
 * vouch for.
 */
function completedPhase(version: string | undefined): number {
  const match = /^(\d+)\.(\d+)\./.exec(version ?? '');
  if (!match) return 0;
  // From 1.0.0 every phase is done.
  if (Number(match[1]) >= 1) return Number.POSITIVE_INFINITY;
  return Number(match[2]);
}

const DAY_MS = 24 * 60 * 60 * 1000;

export default async function DashboardPage() {
  const [t, session, info, tenants, clusters, nodes, jobs, failures] = await Promise.all([
    getTranslations(),
    getSession(),
    tryGetSystemInfo(),
    listTenants(),
    listClusters(),
    listNodes(),
    listJobs(),
    listJobs({ status: 'FAILED' }),
  ]);

  // Recommended only where it is genuinely a choice. Repeating the advice at
  // someone whose installation already compels a second factor is noise, and
  // noise is how a notice stops being read.
  const mfaPolicy = session?.user.mfa.policy ?? 'OPTIONAL';
  const phase = completedPhase(info?.version);

  /*
   * Each count is what this account can see — the lists are scoped by the API —
   * and null where it may not see that list at all, which renders as "no
   * access" rather than as a zero that would claim there is nothing there.
   *
   * Unhealthy counts UNKNOWN as well as WARNING and CRITICAL. A cluster Velnox
   * knows nothing about must never be counted as fine.
   */
  const since = Date.now() - DAY_MS;
  const counts: Partial<Record<TileKey, number | null>> = {
    tenants: tenants.ok ? tenants.data.tenants.length : null,
    clusters: clusters.ok ? clusters.data.clusters.length : null,
    nodes: nodes.ok ? nodes.data.nodes.length : null,
    unhealthyClusters: clusters.ok
      ? clusters.data.clusters.filter((cluster) => cluster.health !== 'OK').length
      : null,
    runningJobs: jobs.ok
      ? jobs.data.jobs.filter((job) => ACTIVE_JOB_STATUSES.has(job.status)).length
      : null,
    recentFailures: failures.ok
      ? failures.data.jobs.filter((job) => job.finishedAt && Date.parse(job.finishedAt) >= since)
          .length
      : null,
  };

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

        <Card title={t('dashboard.subtitle')}>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {TILES.map((tile) => {
              const live = tile.phase <= phase;
              const count = counts[tile.key];

              const body = (
                <>
                  <p className="truncate text-xs text-ink-muted">{t(`dashboard.tiles.${tile.key}`)}</p>
                  {live && count !== null && count !== undefined ? (
                    <p className="mt-1 font-mono text-xl leading-none tabular-nums text-ink">{count}</p>
                  ) : (
                    <p className="mt-1 font-mono text-xl leading-none text-ink-muted/60">—</p>
                  )}
                  <p className="mt-1.5 text-[10px] uppercase tracking-wide text-ink-muted">
                    {!live
                      ? t('dashboard.tileUnavailable', { phase: tile.phase })
                      : count === null
                        ? t('dashboard.tileNoAccess')
                        : tile.key === 'recentFailures'
                          ? t('dashboard.tileLast24h')
                          : ' '}
                  </p>
                </>
              );

              return (
                <li key={tile.key}>
                  {live && tile.href && count !== null ? (
                    <Link
                      href={tile.href}
                      className="block rounded border border-line bg-surface-2 px-3 py-2.5 transition-colors hover:border-line-strong hover:bg-surface-3"
                    >
                      {body}
                    </Link>
                  ) : (
                    <div className="rounded border border-line bg-surface-2 px-3 py-2.5">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      </div>
    </>
  );
}

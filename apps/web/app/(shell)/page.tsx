import Link from 'next/link';
import { getFormatter, getLocale, getTimeZone, getTranslations } from 'next-intl/server';
import { Card, PageHeader } from '@/components/ui/primitives';
import { JobActivityChart } from '@/components/dashboard/job-activity-chart';
import { AttentionList, CapacityList, StatTile, UpdateStatus, type AttentionItem } from '@/components/dashboard/parts';
import { RecentJobs } from '@/components/dashboard/recent-jobs';
import { tryGetSystemInfo } from '@/lib/api';
import { capacityByCluster, fullStorages, updateSplit } from '@/lib/dashboard';
import { roadmapPhases } from '@/lib/roadmap';
import {
  getJobActivity,
  getSession,
  listAlerts,
  listClusters,
  listJobs,
  listNodes,
  listStorages,
  listTenants,
  listUpgradePlans,
  listWorkloads,
} from '@/lib/session';

export const dynamic = 'force-dynamic';

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVITY_DAYS = 14;
/** What the job list returns at most: at this many, there may be more. */
const JOB_PAGE = 100;

/**
 * The state of the fleet at a glance: what there is, what needs someone, how
 * full it is, and how the work of the last two weeks went.
 *
 * Every figure is what this account can see, because the lists are scoped by
 * the API. One it may not read is a dash that says so, never a zero that would
 * claim there is nothing there. There is no invented trend either: Velnox keeps
 * no metric history yet, so capacity is the last reading, and the one chart over
 * time is drawn from job records that really exist.
 */
export default async function DashboardPage() {
  const timeZone = await getTimeZone();
  const [
    t,
    format,
    locale,
    session,
    info,
    tenants,
    clusters,
    nodes,
    workloads,
    storages,
    alerts,
    recent,
    active,
    failures,
    plans,
    activity,
  ] = await Promise.all([
    getTranslations(),
    getFormatter(),
    getLocale(),
    getSession(),
    tryGetSystemInfo(),
    listTenants(),
    listClusters(),
    listNodes(),
    listWorkloads(),
    listStorages(),
    listAlerts(),
    listJobs(),
    listJobs({ active: true }),
    listJobs({ status: 'FAILED' }),
    listUpgradePlans(),
    getJobActivity(ACTIVITY_DAYS, timeZone),
  ]);

  const phases = roadmapPhases(locale);
  const complete = phases.filter((p) => p.status === 'complete');
  const built = phases.filter((p) => p.status === 'built');
  const next = phases.find((p) => p.status === 'planned');

  const clusterList = clusters.ok ? clusters.data.clusters : [];
  const nodeList = nodes.ok ? nodes.data.nodes : [];
  const storageList = storages.ok ? storages.data.storages : [];
  const guests = workloads.ok ? workloads.data.workloads.filter((w) => !w.template) : [];
  const vms = guests.filter((w) => w.kind === 'QEMU');
  const containers = guests.filter((w) => w.kind === 'LXC');
  const running = (list: typeof guests) => list.filter((w) => w.state === 'RUNNING').length;
  const activeJobs = active.ok ? active.data.jobs : [];
  const waiting = activeJobs.filter((job) => job.status === 'WAITING_APPROVAL').length;

  const since = Date.now() - DAY_MS;
  const failedRecently = failures.ok
    ? failures.data.jobs.filter((job) => job.finishedAt && Date.parse(job.finishedAt) >= since).length
    : 0;
  const alertList = alerts.ok ? alerts.data.alerts : [];
  const severity = {
    critical: t('dashboard.severity.critical'),
    warning: t('dashboard.severity.warning'),
    info: t('dashboard.severity.info'),
  };
  const candidates: AttentionItem[] = [
    {
      key: 'criticalAlerts',
      label: t('dashboard.attention.criticalAlerts'),
      tone: 'error',
      severity: severity.critical,
      count: alertList.filter((a) => a.severity === 'CRITICAL').length,
      href: '/alerts',
    },
    {
      key: 'nodesOffline',
      label: t('dashboard.attention.nodesOffline'),
      tone: 'error',
      severity: severity.critical,
      count: nodeList.filter((n) => n.state !== 'ONLINE').length,
      href: '/nodes',
    },
    {
      key: 'upgradeBlockers',
      label: t('dashboard.attention.upgradeBlockers'),
      tone: 'error',
      severity: severity.critical,
      count: plans.ok ? plans.data.plans.filter((p) => p.status === 'BLOCKED').length : 0,
      href: '/major-upgrades',
    },
    {
      key: 'recentFailures',
      label: t('dashboard.attention.recentFailures'),
      tone: 'error',
      severity: severity.critical,
      // The list stops at a page, so a full page of them is "at least".
      count: failedRecently >= JOB_PAGE ? `${JOB_PAGE}+` : failedRecently,
      href: '/jobs?status=FAILED',
    },
    {
      key: 'approvals',
      label: t('dashboard.attention.approvals'),
      tone: 'warn',
      severity: severity.warning,
      count: waiting,
      href: '/jobs?status=WAITING_APPROVAL',
    },
    {
      key: 'unhealthyClusters',
      label: t('dashboard.attention.unhealthyClusters'),
      tone: 'warn',
      severity: severity.warning,
      // UNKNOWN counts: a cluster Velnox knows nothing about is never "fine".
      count: clusterList.filter((c) => c.health !== 'OK').length,
      href: '/clusters',
    },
    {
      key: 'warningAlerts',
      label: t('dashboard.attention.warningAlerts'),
      tone: 'warn',
      severity: severity.warning,
      count: alertList.filter((a) => a.severity === 'WARNING').length,
      href: '/alerts',
    },
    {
      key: 'storageFull',
      label: t('dashboard.attention.storageFull'),
      tone: 'warn',
      severity: severity.warning,
      count: fullStorages(storageList).length,
      href: '/storage',
    },
    {
      key: 'nodesNeedingUpdates',
      label: t('dashboard.attention.nodesNeedingUpdates'),
      tone: 'neutral',
      severity: severity.info,
      count: nodeList.filter((n) => (n.updatesAvailable ?? 0) > 0).length,
      href: '/updates',
    },
  ];
  const attention = candidates.filter((item) => item.count !== 0);
  if (session && !session.user.mfa.enrolled && session.user.mfa.policy === 'OPTIONAL') {
    attention.push({
      key: 'mfa',
      label: t('dashboard.attention.mfa'),
      tone: 'neutral',
      severity: severity.info,
      count: null,
      href: '/settings/security',
    });
  }
  const partial = [clusters, nodes, storages, alerts, active, failures, plans].some((r) => !r.ok);

  return (
    <>
      <PageHeader title={t('dashboard.title')} description={t('dashboard.subtitle')} />

      <div className="space-y-5">
        <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <li>
            <StatTile
              label={t('dashboard.tiles.tenants')}
              value={tenants.ok ? tenants.data.tenants.filter((x) => x.status !== 'ARCHIVED').length : null}
              href="/tenants"
            />
          </li>
          <li>
            <StatTile
              label={t('dashboard.tiles.clusters')}
              value={clusters.ok ? clusterList.length : null}
              detail={t('dashboard.tileHealthy', {
                count: clusterList.filter((c) => c.health === 'OK').length,
              })}
              href="/clusters"
            />
          </li>
          <li>
            <StatTile
              label={t('dashboard.tiles.nodes')}
              value={nodes.ok ? nodeList.length : null}
              detail={t('dashboard.tileOnline', {
                count: nodeList.filter((n) => n.state === 'ONLINE').length,
              })}
              href="/nodes"
            />
          </li>
          <li>
            <StatTile
              label={t('dashboard.tiles.vms')}
              value={workloads.ok ? vms.length : null}
              detail={t('dashboard.tileRunning', { count: running(vms) })}
              href="/virtual-machines"
            />
          </li>
          <li>
            <StatTile
              label={t('dashboard.tiles.containers')}
              value={workloads.ok ? containers.length : null}
              detail={t('dashboard.tileRunning', { count: running(containers) })}
              href="/containers"
            />
          </li>
          <li>
            <StatTile
              label={t('dashboard.tiles.runningJobs')}
              value={active.ok ? activeJobs.length : null}
              detail={
                waiting > 0
                  ? t('dashboard.tileWaiting', { count: waiting })
                  : t('dashboard.tileNoneWaiting')
              }
              href="/jobs"
            />
          </li>
        </ul>

        <div className="grid gap-5 lg:grid-cols-3">
          <Card
            className="lg:col-span-2"
            title={t('dashboard.activityTitle')}
            description={t('dashboard.activityBody', { days: ACTIVITY_DAYS })}
          >
            {activity.ok ? (
              <JobActivityChart days={activity.data.days} truncated={activity.data.truncated} />
            ) : (
              <p className="py-10 text-center text-sm text-ink-muted">
                {activity.code === 'authz.forbidden' ? t('dashboard.tileNoAccess') : t('errors.generic')}
              </p>
            )}
          </Card>
          <Card title={t('dashboard.attentionTitle')}>
            <AttentionList items={attention} partial={partial} />
          </Card>
        </div>

        <div className="grid gap-5 lg:grid-cols-3">
          <Card
            className="lg:col-span-2"
            title={t('dashboard.capacityTitle')}
            description={t('dashboard.capacityBody')}
          >
            {clusters.ok && nodes.ok ? (
              <CapacityList rows={capacityByCluster(clusterList, nodeList, storageList)} />
            ) : (
              <p className="py-6 text-center text-sm text-ink-muted">{t('dashboard.tileNoAccess')}</p>
            )}
          </Card>
          <Card title={t('dashboard.updatesTitle')} description={t('dashboard.updatesBody')}>
            {nodes.ok ? (
              <UpdateStatus split={updateSplit(nodeList)} />
            ) : (
              <p className="py-6 text-center text-sm text-ink-muted">{t('dashboard.tileNoAccess')}</p>
            )}
          </Card>
        </div>

        <Card
          title={t('dashboard.recentTitle')}
          actions={
            <Link href="/jobs" className="text-xs text-accent underline">
              {t('dashboard.recentAll')}
            </Link>
          }
        >
          {recent.ok ? (
            <RecentJobs jobs={recent.data.jobs.slice(0, 6)} />
          ) : (
            <p className="text-sm text-ink-muted">{t('dashboard.tileNoAccess')}</p>
          )}
        </Card>

        <details className="rounded-md border border-line bg-surface px-4 py-3 text-sm text-ink-muted shadow-card">
          <summary className="cursor-pointer font-medium text-ink">
            {t('dashboard.phaseNoticeTitle', { version: info?.version ?? '—' })}
          </summary>
          <div className="mt-2 space-y-1">
            {complete.length > 0 && (
              <p>{t('dashboard.phaseComplete', { phases: format.list(complete.map((p) => p.id)) })}</p>
            )}
            {built.length > 0 && (
              <p>
                {t('dashboard.phaseBuilt', {
                  phases: format.list(built.map((p) => `${p.id} (${p.name})`)),
                })}
              </p>
            )}
            {next && <p>{t('dashboard.phaseNext', { phase: `${next.id} — ${next.name}` })}</p>}
            <p>
              <Link href="/docs/roadmap" className="text-accent underline">
                {t('dashboard.phaseRoadmap')}
              </Link>
            </p>
          </div>
        </details>
      </div>
    </>
  );
}

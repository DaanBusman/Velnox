import { z } from 'zod';
import { compareVersions } from './updates';
import type { PlaybookStepDef, UpgradePlaybookDef } from './upgrade';

/**
 * Ceph major upgrades (Phase 9A): the version matrix, which release a
 * version is, what may stand in Ceph's health while it upgrades, and the
 * playbook. Pure; the worker runs it, the API plans with it.
 */

export const CEPH_RELEASES = [
  { name: 'quincy', major: 17 },
  { name: 'reef', major: 18 },
  { name: 'squid', major: 19 },
] as const;
export type CephRelease = (typeof CEPH_RELEASES)[number]['name'];
export const CEPH_RELEASE_NAMES = CEPH_RELEASES.map((r) => r.name) as CephRelease[];

/** `18.2.4`, `18.2.4-pve3`, `ceph version 18.2.4 (…) reef (stable)` → `reef`; unknown → null. */
export function releaseOf(version: string | null | undefined): CephRelease | null {
  const match = /(\d+)\.\d+\.\d+/.exec(version ?? '');
  if (!match) return null;
  return CEPH_RELEASES.find((r) => r.major === Number(match[1]))?.name ?? null;
}

export const releaseMajor = (release: CephRelease): number =>
  CEPH_RELEASES.find((r) => r.name === release)!.major;

export interface CephMatrixEntry {
  from: CephRelease;
  to: CephRelease;
  /** The lowest version of `from` Proxmox supports upgrading from. */
  minFrom: string;
  /** The lowest pve-manager the target's packages need. */
  minPveManager: string;
  /** Proxmox's repository directory for the target: `ceph-squid`. */
  repo: string;
  /** The Debian suite the repository is for. */
  suite: string;
  /** The version the fixture and the report expect after: the target's release line. */
  guide: string;
}

/**
 * The version matrix: the upgrades Velnox performs, each as Proxmox documents
 * it. Data, dated, and recorded with every plan made from it, so a report
 * can be read against the matrix that produced it.
 */
export const CEPH_MATRIX_VERSION = '2026-10-11';
export const CEPH_MATRIX: readonly CephMatrixEntry[] = [
  {
    from: 'quincy',
    to: 'reef',
    minFrom: '17.2.7',
    minPveManager: '8.0.0',
    repo: 'ceph-reef',
    suite: 'bookworm',
    guide: 'https://pve.proxmox.com/wiki/Ceph_Quincy_to_Reef',
  },
  {
    from: 'reef',
    to: 'squid',
    minFrom: '18.2.4',
    minPveManager: '8.2.8',
    repo: 'ceph-squid',
    suite: 'bookworm',
    guide: 'https://pve.proxmox.com/wiki/Ceph_Reef_to_Squid',
  },
];

export const CEPH_CHANNELS = ['no-subscription', 'enterprise'] as const;
export type CephChannel = (typeof CEPH_CHANNELS)[number];

/** The one line of `/etc/apt/sources.list.d/ceph.list` for a release and channel. */
export function cephRepoLine(
  entry: Pick<CephMatrixEntry, 'repo' | 'suite'>,
  channel: CephChannel,
): string {
  return channel === 'enterprise'
    ? `deb https://enterprise.proxmox.com/debian/${entry.repo} ${entry.suite} enterprise`
    : `deb http://download.proxmox.com/debian/${entry.repo} ${entry.suite} no-subscription`;
}

export type MatrixOutcome =
  | { ok: true; entry: CephMatrixEntry; from: CephRelease }
  | {
      ok: false;
      /** Which of the three is unexpected: what runs, what was asked for, or the matrix. */
      unexpected: 'running' | 'target' | 'matrix';
      reason: string;
    };

/**
 * Whether the running release, the target and the matrix agree. When they do
 * not, says which of the three is the unexpected one.
 */
export function checkMatrix(
  daemonVersions: readonly (string | null)[],
  target: string,
  matrix: readonly CephMatrixEntry[] = CEPH_MATRIX,
): MatrixOutcome {
  const releases = [...new Set(daemonVersions.map(releaseOf))];
  if (!daemonVersions.length)
    return { ok: false, unexpected: 'running', reason: 'no Ceph daemons are known' };
  if (releases.includes(null)) {
    const odd = daemonVersions.filter((v) => !releaseOf(v));
    return {
      ok: false,
      unexpected: 'running',
      reason: `running ${odd.map((v) => v ?? 'an unknown version').join(', ')}, which is no release Velnox knows`,
    };
  }
  if (releases.length > 1) {
    return {
      ok: false,
      unexpected: 'running',
      reason: `daemons run ${releases.join(' and ')}: the cluster is already mid-upgrade`,
    };
  }
  const from = releases[0] as CephRelease;
  if (!(CEPH_RELEASE_NAMES as string[]).includes(target)) {
    return { ok: false, unexpected: 'target', reason: `${target} is no Ceph release Velnox knows` };
  }
  if (releaseMajor(target as CephRelease) <= releaseMajor(from)) {
    return {
      ok: false,
      unexpected: 'target',
      reason: `${target} is not newer than ${from}, which runs`,
    };
  }
  const entry = matrix.find((e) => e.from === from && e.to === target);
  if (!entry) {
    return {
      ok: false,
      unexpected: 'matrix',
      reason: `the version matrix has no upgrade from ${from} to ${target}${
        matrix.some((e) => e.from === from)
          ? `; from ${from} it goes to ${matrix
              .filter((e) => e.from === from)
              .map((e) => e.to)
              .join(', ')}`
          : ''
      }`,
    };
  }
  const low = daemonVersions.filter(
    (v) => compareVersions(v!.replace(/-.*/, ''), entry.minFrom) < 0,
  );
  if (low.length) {
    return {
      ok: false,
      unexpected: 'running',
      reason: `the matrix needs ${from} ${entry.minFrom} or later; running ${[...new Set(low)].join(', ')}`,
    };
  }
  return { ok: true, entry, from };
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/** The warnings an upgrade itself causes, and nothing else, may stand while it runs. */
export const CEPH_UPGRADE_WARNINGS: Record<string, RegExp> = {
  /** Velnox set noout itself. */
  OSDMAP_FLAGS: /^noout flag\(s\) set$/,
  /** Every OSD runs the new release; require-osd-release is raised last. */
  OSD_UPGRADE_FINISHED: /require_osd_release/,
};

/**
 * What a daemon's restart causes for a moment: known, so waited out rather
 * than treated as unknown — and never accepted as done. Before an upgrade
 * starts they block like any other problem.
 */
export const CEPH_TRANSIENT_WARNINGS = new Set([
  'MON_DOWN',
  'MGR_DOWN',
  'OSD_DOWN',
  'OSD_HOST_DOWN',
  'PG_DEGRADED',
  'PG_AVAILABILITY',
  'OBJECT_MISPLACED',
]);

export interface CephStatusLike {
  health?: {
    status?: string;
    checks?: Record<string, { severity?: string; summary?: { message?: string } }>;
  };
  monmap?: { mons?: { name?: string }[]; min_mon_release_name?: string };
  quorum_names?: string[];
  pgmap?: { num_pgs?: number; pgs_by_state?: { state_name: string; count: number }[] };
}

/**
 * Whether Ceph is whole enough to go on: health OK, or a warning the upgrade
 * itself causes; every placement group active+clean; every monitor in
 * quorum. An unrecognised warning stops the upgrade — it is never guessed at.
 */
export function assessCephHealth(
  status: CephStatusLike,
  allowUpgradeWarnings: boolean,
): { ok: boolean; problems: string[]; unknown: string[] } {
  const problems: string[] = [];
  const unknown: string[] = [];
  const checks = status.health?.checks ?? {};
  for (const [code, check] of Object.entries(checks)) {
    const message = check.summary?.message ?? code;
    const allowed = allowUpgradeWarnings && CEPH_UPGRADE_WARNINGS[code]?.test(message);
    if (allowed) continue;
    if (check.severity === 'HEALTH_ERR') problems.push(`${code}: ${message}`);
    else if (CEPH_UPGRADE_WARNINGS[code] || CEPH_TRANSIENT_WARNINGS.has(code))
      problems.push(`${code}: ${message}`);
    else unknown.push(`${code}: ${message}`);
  }
  if (
    !Object.keys(checks).length &&
    status.health?.status &&
    status.health.status !== 'HEALTH_OK'
  ) {
    problems.push(`Ceph is ${status.health.status}`);
  }
  const pgs = status.pgmap?.pgs_by_state ?? [];
  const unclean = pgs
    .filter((p) => p.state_name !== 'active+clean')
    .reduce((n, p) => n + p.count, 0);
  if (unclean > 0) {
    problems.push(
      `${unclean} placement group${unclean === 1 ? ' is' : 's are'} not active+clean (${pgs
        .filter((p) => p.state_name !== 'active+clean')
        .map((p) => `${p.count} ${p.state_name}`)
        .join(', ')})`,
    );
  }
  const mons = (status.monmap?.mons ?? []).map((m) => m.name ?? '?');
  const quorum = new Set(status.quorum_names ?? []);
  const missing = mons.filter((m) => !quorum.has(m));
  if (missing.length)
    problems.push(`monitor${missing.length === 1 ? '' : 's'} ${missing.join(', ')} not in quorum`);
  return { ok: !problems.length && !unknown.length, problems, unknown };
}

// ---------------------------------------------------------------------------
// The playbook
// ---------------------------------------------------------------------------

const steps: PlaybookStepDef[] = [
  { key: 'facts', phase: 'discovery', action: 'ceph.facts' },
  { key: 'checks', phase: 'preflight', action: 'checks.run' },
  { key: 'remediate-auto', phase: 'remediation', action: 'remediate.automatic' },
  { key: 'remediate-approve', phase: 'remediation', action: 'remediate.approval' },
  { key: 'remediate-approved', phase: 'remediation', action: 'remediate.approved' },
  { key: 'recheck', phase: 'recheck', action: 'checks.run', params: { recheck: true } },
  { key: 'gate', phase: 'recheck', action: 'checks.gate' },
  { key: 'repository', phase: 'upgrade', action: 'ceph.repository' },
  { key: 'noout', phase: 'upgrade', action: 'ceph.noout-set' },
  { key: 'packages', phase: 'upgrade', action: 'ceph.packages' },
  { key: 'restart', phase: 'upgrade', action: 'ceph.restart', perTarget: true },
  { key: 'settle', phase: 'upgrade', action: 'ceph.settle', perTarget: true },
  { key: 'require-release', phase: 'upgrade', action: 'ceph.require-osd-release' },
  { key: 'noout-unset', phase: 'upgrade', action: 'ceph.noout-unset' },
  { key: 'verify', phase: 'validation', action: 'ceph.verify' },
  { key: 'report', phase: 'report', action: 'report.build' },
];

export const CEPH_MAJOR_PLAYBOOK: UpgradePlaybookDef = {
  id: 'velnox.ceph-major',
  version: 1,
  title: 'Ceph major upgrade',
  kind: 'CEPH',
  targetKind: 'CEPH_DAEMON',
  internal: false,
  checkProviders: ['ceph.preflight'],
  cleanup: 'ceph.noout-cleanup',
  steps,
};

export const cephPlanOptionsSchema = z
  .object({
    /** A release name; checked against the matrix, which names what is wrong. */
    target: z.string().trim().min(1).max(20),
    channel: z.enum(CEPH_CHANNELS).default('no-subscription'),
    /**
     * CephFS only: the operator has set `max_mds 1` and switched standby replay
     * off for every file system, as Proxmox's guide asks. Velnox restarts MDS
     * daemons one at a time and does not change those settings itself.
     */
    mdsPrepared: z.boolean().default(false),
    /** Seconds Ceph may take to be whole again after each daemon restart. */
    settleSeconds: z.number().int().min(10).max(3600).default(600),
  })
  .strict();
export type CephPlanOptions = z.infer<typeof cephPlanOptionsSchema>;

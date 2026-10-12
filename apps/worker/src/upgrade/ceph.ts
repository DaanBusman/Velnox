import { waitForTask, type ProxmoxClient } from '@velnox/proxmox';
import {
  ERROR_CODES,
  assessCephHealth,
  cephPlanOptionsSchema,
  checkMatrix,
  compareVersions,
  releaseMajor,
  releaseOf,
  type CephMatrixEntry,
  type CephPlanOptions,
  type CephRelease,
  type CephStatusLike,
  type Facts,
} from '@velnox/shared';
import { StepError } from '../jobs/steps';
import { cephRepoCommand, cephRequireReleaseCommand } from '../remote/commands';
import {
  distUpgrade,
  refreshLists,
  runRegistered,
  sshFor,
  type NodeHandle,
} from '../updates/node-ops';
import {
  mergeFacts,
  plan,
  type CheckProvider,
  type PlanRow,
  type UpgradeAction,
  type UpgradeRuntime,
} from './runtime';

/**
 * The Ceph major upgrade's own pieces (Phase 9A), as Proxmox's guides do it:
 * the repository switched on every node, `noout` set, packages upgraded on
 * every node, then every daemon restarted in Ceph's order — monitors,
 * managers, OSDs, MDS, RGW — one at a time, with Ceph's health read again
 * after each and an unrecognised warning stopping the run; then
 * `require-osd-release` raised once every OSD runs the new release, and
 * `noout` cleared. `noout` is cleared too when the run fails, is cancelled or
 * its worker dies — the cleanup below, which the engine and its driver call.
 */

interface CephFacts {
  release: CephRelease | null;
  target: CephRelease;
  entry: CephMatrixEntry;
  nooutSetByVelnox: boolean;
  nooutBefore: boolean;
}

const optionsOf = (row: PlanRow): CephPlanOptions => cephPlanOptionsSchema.parse(row.options ?? {});
const cephFacts = (row: PlanRow): CephFacts | null =>
  ((row.facts as Facts).cephUpgrade as CephFacts) ?? null;

async function withPve<T>(rt: UpgradeRuntime, run: (pve: ProxmoxClient) => Promise<T>): Promise<T> {
  const { client } = await rt.services.connect(rt.params.clusterId);
  try {
    return await run(client);
  } finally {
    client.close();
  }
}

/** Every daemon's running version, by Ceph's own name for it. */
async function runningVersions(
  pve: ProxmoxClient,
): Promise<Map<string, { version: string | null; host: string | null }>> {
  const metadata = (await pve.cephMetadata()) as unknown as Record<
    string,
    Record<
      string,
      {
        name?: string;
        id?: number;
        hostname?: string;
        ceph_version_short?: string;
        ceph_version?: string;
      }
    >
  >;
  const out = new Map<string, { version: string | null; host: string | null }>();
  for (const kind of ['mon', 'mgr', 'osd', 'mds', 'rgw']) {
    for (const [key, entry] of Object.entries(metadata[kind] ?? {})) {
      const raw = entry?.name ?? key;
      const name = raw.startsWith(`${kind}.`) ? raw : `${kind}.${raw}`;
      out.set(name, {
        version: entry?.ceph_version_short ?? entry?.ceph_version ?? null,
        host: entry?.hostname ?? null,
      });
    }
  }
  return out;
}

const nodesOf = async (rt: UpgradeRuntime) =>
  rt.prisma.node.findMany({ where: { clusterId: rt.params.clusterId }, orderBy: { name: 'asc' } });

function handleFor(
  rt: UpgradeRuntime,
  pve: ProxmoxClient,
  node: string,
  context: Parameters<UpgradeAction>[0]['context'],
): NodeHandle {
  return {
    node,
    pve,
    signal: context.signal,
    log: (stream, text) =>
      context.log(
        stream,
        text
          .split('\n')
          .map((line) => `[${node}] ${line}`)
          .join('\n'),
      ),
    sleep: context.sleep,
    ssh: sshFor(rt.services, rt.params.clusterId, node),
  };
}

const status = (pve: ProxmoxClient) => pve.cephStatus() as unknown as Promise<CephStatusLike>;
const nooutSet = async (pve: ProxmoxClient) =>
  (await pve.cephFlags()).some((f) => f.name === 'noout' && Number(f.value) === 1);

export const CEPH_PROVIDERS: Record<string, CheckProvider> = {
  'ceph.preflight': async (rt, row) => {
    const options = optionsOf(row);
    return withPve(rt, async (pve) => {
      const out: Awaited<ReturnType<CheckProvider>> = [];
      const add = (
        key: string,
        ok: boolean,
        title: string,
        bad: 'BLOCKER' | 'WARNING' | 'UNKNOWN' = 'BLOCKER',
        rawLine?: string,
      ) =>
        out.push({
          targetId: null,
          source: 'CEPH_HEALTH',
          key,
          severity: ok ? 'PASS' : bad,
          title,
          rawLine,
        });

      const versions = await runningVersions(pve);
      const matrix = checkMatrix(
        [...versions.values()].map((v) => v.version),
        options.target,
      );
      add(
        'ceph.matrix',
        matrix.ok,
        matrix.ok
          ? `Ceph runs ${matrix.from}; the matrix goes to ${options.target}`
          : `Version matrix: ${matrix.reason}`,
      );
      const health = assessCephHealth(await status(pve), false);
      add(
        'ceph.health',
        health.problems.length === 0,
        health.problems.length
          ? `Ceph is not whole: ${health.problems.join('; ')}`
          : 'Ceph is HEALTH_OK, every PG active+clean, every monitor in quorum',
      );
      for (const line of health.unknown) {
        add(
          `ceph.health.${line.split(':')[0]!.toLowerCase()}`,
          false,
          `A Ceph warning Velnox does not know: ${line}`,
          'UNKNOWN',
          line,
        );
      }
      if (matrix.ok) {
        const nodes = await nodesOf(rt);
        const old = nodes.filter(
          (n) =>
            !n.pveVersion ||
            compareVersions(
              n.pveVersion.replace(/^pve-manager\//, '').replace(/\/.*$/, ''),
              matrix.entry.minPveManager,
            ) < 0,
        );
        add(
          'pve.manager',
          old.length === 0,
          old.length
            ? `Ceph ${options.target} needs pve-manager ${matrix.entry.minPveManager} or later; ${old.map((n) => `${n.name} has ${n.pveVersion ?? 'an unknown version'}`).join(', ')}`
            : `Every node has pve-manager ${matrix.entry.minPveManager} or later`,
        );
        const unready = nodes.filter((n) => !n.sshHostKeyFingerprint);
        const cluster = await rt.prisma.cluster.findUnique({
          where: { id: rt.params.clusterId },
          select: { sshCredentialId: true },
        });
        add(
          'ceph.ssh',
          Boolean(cluster?.sshCredentialId) && unready.length === 0,
          cluster?.sshCredentialId && !unready.length
            ? 'SSH reaches every node, for the repository and the packages'
            : `SSH is needed on every node for the repository and the packages${unready.length ? `; not confirmed for ${unready.map((n) => n.name).join(', ')}` : ''}`,
        );
      }
      const mds = [...versions.keys()].filter((name) => name.startsWith('mds.'));
      if (mds.length) {
        add(
          'ceph.mds',
          options.mdsPrepared,
          options.mdsPrepared
            ? 'CephFS is prepared: one active MDS per file system, standby replay off'
            : `CephFS MDS daemons (${mds.join(', ')}): set max_mds 1 and switch standby replay off for every file system first, then say so in the plan`,
        );
      }
      const preset = await nooutSet(pve);
      add(
        'ceph.noout-preset',
        !preset,
        preset ? 'noout is already set; Velnox leaves it set when it finishes' : 'noout is not set',
        'WARNING',
      );
      return out;
    });
  },
};

/** Clear noout if Velnox set it — after success, failure, cancellation or a dead worker. */
export async function cephNooutCleanup(
  rt: UpgradeRuntime,
  log: (text: string) => Promise<void>,
): Promise<void> {
  const row = await plan(rt);
  const facts = cephFacts(row);
  if (!facts?.nooutSetByVelnox) return;
  await withPve(rt, async (pve) => {
    await pve.setCephFlag('noout', false);
    if (await nooutSet(pve)) throw new Error('noout is still set after clearing it');
  });
  await mergeFacts(rt, { cephUpgrade: { ...facts, nooutSetByVelnox: false } });
  await log('noout cleared');
}

export const CEPH_ACTIONS: Record<string, UpgradeAction> = {
  'ceph.facts': async ({ rt, context }) => {
    const row = await plan(rt);
    const options = optionsOf(row);
    await withPve(rt, async (pve) => {
      const versions = await runningVersions(pve);
      const matrix = checkMatrix(
        [...versions.values()].map((v) => v.version),
        options.target,
      );
      const before = await nooutSet(pve);
      const facts: Facts = {
        cluster: { daemons: versions.size },
        ceph: { health: (await status(pve)).health?.status ?? null },
      };
      if (matrix.ok) {
        facts.cephUpgrade = {
          release: matrix.from,
          target: matrix.entry.to,
          entry: matrix.entry,
          nooutSetByVelnox: cephFacts(row)?.nooutSetByVelnox ?? false,
          nooutBefore: before,
        } satisfies CephFacts;
      }
      await mergeFacts(rt, facts);
      await context.log(
        'STDOUT',
        `${versions.size} Ceph daemons; ${matrix.ok ? `${matrix.from} → ${matrix.entry.to}` : matrix.reason}; noout ${before ? 'already set' : 'not set'}`,
      );
    });
    await rt.prisma.upgradePlan.update({
      where: { id: row.id },
      data: { status: 'RUNNING', startedAt: row.startedAt ?? new Date() },
    });
  },

  'ceph.repository': async ({ rt, context }) => {
    const row = await plan(rt);
    const facts = cephFacts(row);
    if (!facts)
      throw new StepError(ERROR_CODES.upgradeMatrixMismatch, 'No matrix entry for this plan', {});
    const spec = cephRepoCommand(facts.entry, optionsOf(row).channel);
    await withPve(rt, async (pve) => {
      for (const node of await nodesOf(rt)) {
        const handle = handleFor(rt, pve, node.name, context);
        await handle.log('STDOUT', `Switching the Ceph repository to ${facts.entry.repo}`);
        await runRegistered(handle, spec, true);
      }
    });
  },

  'ceph.noout-set': async ({ rt, context }) => {
    const row = await plan(rt);
    const facts = cephFacts(row)!;
    await withPve(rt, async (pve) => {
      if (await nooutSet(pve)) {
        await context.log('STDOUT', 'noout was already set; Velnox leaves it as it found it');
        return;
      }
      // Recorded before it is set: a failure between the two still clears it.
      await mergeFacts(rt, { cephUpgrade: { ...facts, nooutSetByVelnox: true } });
      await pve.setCephFlag('noout', true);
      if (!(await nooutSet(pve)))
        throw new StepError(ERROR_CODES.upgradeCephUnhealthy, 'noout did not take', {
          reason: 'noout',
        });
      await context.log('STDOUT', 'noout set: OSDs restarting are not marked out');
    });
  },

  'ceph.packages': async ({ rt, context }) => {
    await withPve(rt, async (pve) => {
      for (const node of await nodesOf(rt)) {
        const handle = handleFor(rt, pve, node.name, context);
        await refreshLists(handle);
        await distUpgrade(handle);
      }
    });
    await context.log(
      'STDOUT',
      'Packages upgraded on every node; the daemons still run the old release until restarted',
    );
  },

  /** One daemon, restarted on its host, and proven to run the new release. */
  'ceph.restart': async ({ rt, target, context }) => {
    if (!target) return;
    const row = await plan(rt);
    const facts = cephFacts(row)!;
    const options = optionsOf(row);
    await withPve(rt, async (pve) => {
      const before = (await runningVersions(pve)).get(target.label);
      const host = before?.host;
      if (!host) {
        throw new StepError(
          ERROR_CODES.upgradeTargetFailed,
          `${target.label} has no host in Ceph's metadata`,
          {
            target: target.label,
          },
        );
      }
      await rt.prisma.upgradeTarget.update({
        where: { id: target.id },
        data: {
          status: 'RUNNING',
          startedAt: new Date(),
          preState: { version: before?.version ?? null },
        },
      });
      await context.log(
        'STDOUT',
        `Restarting ${target.label} on ${host} (runs ${before?.version ?? 'unknown'})`,
      );
      const upid = await pve.restartCephService(host, target.label);
      const outcome = await waitForTask(pve, upid, {
        signal: context.signal,
        timeoutMs: 10 * 60_000,
      });
      if (!outcome.succeeded) {
        await rt.prisma.upgradeTarget.update({
          where: { id: target.id },
          data: { status: 'FAILED', finishedAt: new Date() },
        });
        throw new StepError(
          ERROR_CODES.upgradeTargetFailed,
          `Restarting ${target.label} failed: ${outcome.exitStatus}`,
          {
            target: target.label,
          },
        );
      }
      const deadline = Date.now() + options.settleSeconds * 1000;
      let now = before?.version ?? null;
      while (Date.now() < deadline) {
        now = (await runningVersions(pve)).get(target.label)?.version ?? null;
        if (releaseOf(now) === facts.target) break;
        await context.sleep(2000);
      }
      if (releaseOf(now) !== facts.target) {
        await rt.prisma.upgradeTarget.update({
          where: { id: target.id },
          data: { status: 'FAILED', finishedAt: new Date() },
        });
        throw new StepError(
          ERROR_CODES.upgradeTargetFailed,
          `${target.label} still runs ${now ?? 'nothing'} after its restart, not ${facts.target} — were ${host}'s packages upgraded?`,
          { target: target.label },
        );
      }
      await rt.prisma.upgradeTarget.update({
        where: { id: target.id },
        data: { postState: { version: now } },
      });
      await context.log('STDOUT', `${target.label} runs ${now}`);
    });
  },

  /** Ceph whole again after a daemon's restart, before the next. */
  'ceph.settle': async ({ rt, target, context }) => {
    if (!target) return;
    const options = optionsOf(await plan(rt));
    await withPve(rt, async (pve) => {
      const deadline = Date.now() + options.settleSeconds * 1000;
      let last = assessCephHealth(await status(pve), true);
      while (!last.ok && Date.now() < deadline) {
        if (last.unknown.length) break;
        await context.sleep(2000);
        last = assessCephHealth(await status(pve), true);
      }
      if (!last.ok) {
        await rt.prisma.upgradeTarget.update({
          where: { id: target.id },
          data: { status: 'FAILED', finishedAt: new Date() },
        });
        const why = [
          ...last.unknown.map((u) => `a warning Velnox does not know: ${u}`),
          ...last.problems,
        ];
        throw new StepError(
          ERROR_CODES.upgradeCephUnhealthy,
          `After ${target.label}: ${why.join('; ')}${last.unknown.length ? '' : ` (waited ${options.settleSeconds} s)`}`,
          { target: target.label, reason: why.join('; ') },
        );
      }
      await rt.prisma.upgradeTarget.update({
        where: { id: target.id },
        data: { status: 'DONE', finishedAt: new Date() },
      });
      await context.log('STDOUT', `Ceph is whole after ${target.label}`);
    });
  },

  'ceph.require-osd-release': async ({ rt, context }) => {
    const facts = cephFacts(await plan(rt))!;
    await withPve(rt, async (pve) => {
      const osds = [...(await runningVersions(pve)).entries()].filter(([name]) =>
        name.startsWith('osd.'),
      );
      const behind = osds.filter(([, v]) => releaseOf(v.version) !== facts.target);
      if (behind.length) {
        throw new StepError(
          ERROR_CODES.upgradeTargetFailed,
          `Not every OSD runs ${facts.target}: ${behind.map(([n, v]) => `${n} ${v.version}`).join(', ')}`,
          { target: behind.map(([n]) => n).join(', ') },
        );
      }
      const node = (await nodesOf(rt)).find((n) => n.state === 'ONLINE');
      if (!node)
        throw new StepError(ERROR_CODES.upgradeCephUnhealthy, 'No node is online', {
          reason: 'no node',
        });
      await runRegistered(
        handleFor(rt, pve, node.name, context),
        cephRequireReleaseCommand(facts.target),
        true,
      );
      await context.log(
        'STDOUT',
        `require-osd-release is ${facts.target} (major ${releaseMajor(facts.target)})`,
      );
    });
  },

  'ceph.noout-unset': async ({ rt, context }) => {
    await cephNooutCleanup(rt, (text) => context.log('STDOUT', text));
  },

  'ceph.verify': async ({ rt, context }) => {
    const facts = cephFacts(await plan(rt))!;
    await withPve(rt, async (pve) => {
      const versions = [...(await runningVersions(pve)).entries()];
      const odd = versions.filter(([, v]) => releaseOf(v.version) !== facts.target);
      if (odd.length) {
        throw new StepError(
          ERROR_CODES.upgradeTargetFailed,
          `Not every daemon runs ${facts.target}: ${odd.map(([n, v]) => `${n} ${v.version}`).join(', ')}`,
          { target: odd.map(([n]) => n).join(', ') },
        );
      }
      const s = await status(pve);
      const min = s.monmap?.min_mon_release_name;
      if (min && min !== facts.target) {
        throw new StepError(
          ERROR_CODES.upgradeCephUnhealthy,
          `min_mon_release is ${min}, not ${facts.target}`,
          {
            reason: `min_mon_release ${min}`,
          },
        );
      }
      const health = assessCephHealth(s, false);
      const leftover = health.problems.filter(
        (p) => !(facts.nooutBefore && p.startsWith('OSDMAP_FLAGS')),
      );
      if (leftover.length || health.unknown.length) {
        throw new StepError(
          ERROR_CODES.upgradeCephUnhealthy,
          `After the upgrade: ${[...health.unknown, ...leftover].join('; ')}`,
          { reason: [...health.unknown, ...leftover].join('; ') },
        );
      }
      await context.log(
        'STDOUT',
        `Every one of ${versions.length} daemons runs ${facts.target}; Ceph is whole`,
      );
    });
  },

  'ceph.noout-cleanup': async ({ rt, context }) => {
    await cephNooutCleanup(rt, (text) => context.log('STDOUT', text));
  },
};

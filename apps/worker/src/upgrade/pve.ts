import type { Prisma } from '@velnox/db';
import { waitForTask, type ProxmoxClient } from '@velnox/proxmox';
import {
  ERROR_CODES,
  PVE8TO9_FROM,
  PVE8TO9_PARSER_VERSION,
  UPGRADE_REMEDIATIONS,
  assessCephHealth,
  classifyPve8to9,
  compareVersions,
  parsePve8to9,
  placementForbids,
  placementRank,
  pvePlanOptionsSchema,
  releaseOf,
  routeRemediation,
  type ChangeSet,
  type CephStatusLike,
  type Facts,
  type PlannedGuest,
  type PvePlanOptions,
} from '@velnox/shared';
import { StepError, type StepContext } from '../jobs/steps';
import { PVE_COMMANDS, microcodeCommand } from '../remote/commands';
import {
  assessGuests,
  chooseTarget,
  freeMemory,
  moveGuest,
  placementRulesOf,
  positionsOf,
  sharedStorages,
} from '../updates/guests';
import { distUpgrade, rebootIfNeeded, refreshLists, runRegistered } from '../updates/node-ops';
import { quorumAllows } from '../updates/quorum';
import { handleFor, nodesOf, runningVersions, withPve } from './node';
import {
  mergeFacts,
  plan,
  type CheckProvider,
  type Finding,
  type PlanRow,
  type RemediationImpl,
  type TargetRow,
  type UpgradeAction,
  type UpgradeRuntime,
} from './runtime';

/**
 * The Proxmox VE 8 → 9 upgrade's own pieces (Phase 9B), as Proxmox's guide
 * does it: pve8to9 on every node, read and classified; what Velnox can fix
 * of it, fixed — the microcode by itself, the rest after approval, every
 * change shown first; then node by node: running guests moved away, the
 * sources moved to trixie, the dist-upgrade, a reboot (with Ceph's noout set
 * around it), the node checked on PVE 9 and its new kernel and pve8to9 run
 * again, guests moved back. The engine puts a person between the first node
 * and the rest.
 */

interface PveFacts {
  ceph: boolean;
  nooutSetByVelnox: boolean;
}

const optionsOf = (row: PlanRow): PvePlanOptions => pvePlanOptionsSchema.parse(row.options ?? {});
const pveFacts = (row: PlanRow): PveFacts =>
  ((row.facts as Facts).pveUpgrade as PveFacts) ?? { ceph: false, nooutSetByVelnox: false };

const versionOf = (pveversion: string | undefined | null) =>
  /pve-manager\/([\d.]+)/.exec(pveversion ?? '')?.[1] ?? pveversion ?? null;

async function nodeVersion(pve: ProxmoxClient, node: string) {
  const status = (await pve.nodeStatus(node)) as {
    pveversion?: string;
    'current-kernel'?: { release?: string };
  };
  return {
    version: versionOf(status.pveversion),
    kernel: status['current-kernel']?.release ?? null,
  };
}
const onNine = (version: string | null) => Boolean(version && Number(version.split('.')[0]) >= 9);
/** pve8to9 exists from pve-manager 8.4.2 on; below it, running it is "command not found". */
const hasPve8to9 = (version: string | null) =>
  onNine(version) || Boolean(version && compareVersions(version, PVE8TO9_FROM) >= 0);
/** The finding for a node pve8to9 cannot run on yet — fixed by updating it within 8. */
const pve8to9Missing = (targetId: string, label: string, version: string | null): Finding => ({
  targetId,
  source: 'VELNOX_GUARD',
  key: 'pve.pve8to9-missing',
  severity: 'BLOCKER',
  title: `${label} runs pve-manager ${version ?? 'of an unknown version'}; pve8to9 needs ${PVE8TO9_FROM} or later — bring it to the latest Proxmox VE 8 first`,
  remediationId: 'pve.update-bookworm',
  params: { version: version ?? '' },
});

/** pve8to9 on one node, classified. */
async function runPve8to9(
  rt: UpgradeRuntime,
  pve: ProxmoxClient,
  node: string,
  context: StepContext,
): Promise<{
  findings: ReturnType<typeof classifyPve8to9>[];
  lines: ReturnType<typeof parsePve8to9>['lines'];
}> {
  const result = await runRegistered(
    handleFor(rt, pve, node, context),
    PVE_COMMANDS.pve8to9,
    false,
  );
  const parsed = parsePve8to9(result.stdout);
  return { findings: parsed.lines.map(classifyPve8to9), lines: parsed.lines };
}

/** A fresh context for actions that run outside a step: a remediation's validation. */
const quiet = (): StepContext => ({
  signal: new AbortController().signal,
  progress: async () => undefined,
  log: async () => undefined,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});

const targetNode = (row: PlanRow, targetId: string | null): string => {
  const target = row.targets.find((t) => t.id === targetId);
  if (!target)
    throw new StepError(ERROR_CODES.upgradeTargetFailed, 'A remediation without its node', {});
  return target.label;
};

export const PVE_PROVIDERS: Record<string, CheckProvider> = {
  /** The cluster as a whole: quorum, every node, Ceph on Squid, SSH. */
  'pve.cluster': async (rt) =>
    withPve(rt, async (pve) => {
      const out: Finding[] = [];
      const add = (
        key: string,
        ok: boolean,
        title: string,
        bad: 'BLOCKER' | 'WARNING' = 'BLOCKER',
      ) =>
        out.push({
          targetId: null,
          source: 'VELNOX_GUARD',
          key,
          severity: ok ? 'PASS' : bad,
          title,
        });
      const status = await pve.clusterStatus();
      const cluster = status.find((r) => r.type === 'cluster');
      const down = status.filter((r) => r.type === 'node' && r.online !== 1).map((r) => r.name);
      add(
        'pve.cluster-whole',
        (!cluster || cluster.quorate === 1) && !down.length,
        down.length
          ? `${down.join(', ')} offline`
          : cluster && cluster.quorate !== 1
            ? 'The cluster has no quorum'
            : 'The cluster is quorate, every node online',
      );
      const versions = await runningVersions(pve).catch(() => new Map());
      if (versions.size) {
        const releases = [...new Set([...versions.values()].map((v) => releaseOf(v.version)))];
        const squid = releases.length === 1 && releases[0] === 'squid';
        add(
          'pve.ceph-squid',
          squid,
          squid
            ? 'Ceph runs Squid, which Proxmox VE 9 needs'
            : `Ceph runs ${releases.join(' and ')}; Proxmox VE 9 needs Squid — upgrade Ceph first (a composite plan does both, in order)`,
        );
      }
      const cluster2 = await rt.prisma.cluster.findUnique({
        where: { id: rt.params.clusterId },
        select: { sshCredentialId: true },
      });
      const nodes = await nodesOf(rt);
      const unready = nodes.filter((n) => !n.sshHostKeyFingerprint);
      add(
        'pve.ssh',
        Boolean(cluster2?.sshCredentialId) && !unready.length,
        cluster2?.sshCredentialId && !unready.length
          ? 'SSH reaches every node'
          : `SSH is needed on every node${unready.length ? `; not confirmed for ${unready.map((n) => n.name).join(', ')}` : ''}`,
      );
      return out;
    }),

  /** pve8to9 --full on every node, each line kept and classified. */
  'pve.pve8to9': async (rt, row) =>
    withPve(rt, async (pve) => {
      const out: Finding[] = [];
      for (const target of row.targets) {
        // Too old to have pve8to9: say so, rather than fail on "command not found".
        const { version } = await nodeVersion(pve, target.label);
        if (!hasPve8to9(version)) {
          out.push(pve8to9Missing(target.id, target.label, version));
          continue;
        }
        const { lines } = await runPve8to9(rt, pve, target.label, quiet());
        for (const line of lines) {
          const c = classifyPve8to9(line);
          if (!c) continue;
          out.push({
            targetId: target.id,
            source: 'PVE8TO9',
            parserVersion: PVE8TO9_PARSER_VERSION,
            key: c.key,
            severity: c.severity,
            title: c.title,
            detail: line.detail.join('\n') || undefined,
            rawLine: line.raw.slice(0, 4000),
            remediationId: c.remediationId,
            params: c.params,
          });
        }
      }
      return out;
    }),
};

/** A node's pve-manager version, read again while its API restarts after an update. */
async function settledVersion(rt: UpgradeRuntime, node: string): Promise<string | null> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      return await withPve(rt, async (pve) => (await nodeVersion(pve, node)).version);
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
  throw lastError;
}

/** Whether pve8to9 still reports a finding on a node — how every remediation is proven. */
async function stillReported(rt: UpgradeRuntime, node: string, key: string): Promise<boolean> {
  return withPve(rt, async (pve) => {
    const { findings } = await runPve8to9(rt, pve, node, quiet());
    return findings.some(
      (f) => f && f.key === key && f.severity !== 'PASS' && f.severity !== 'INFO',
    );
  });
}

const change = (
  summary: string,
  commands: string[],
  packages: Partial<ChangeSet['packages']> = {},
  files: ChangeSet['files'] = [],
): ChangeSet => ({
  summary,
  files,
  commands,
  packages: { install: packages.install ?? [], remove: packages.remove ?? [] },
});

/** A remediation that is one fixed command, proven by pve8to9 no longer reporting it. */
const commandRemediation = (
  key: string,
  spec: (typeof PVE_COMMANDS)[keyof typeof PVE_COMMANDS],
  summary: string,
  packages: Partial<ChangeSet['packages']> = {},
): RemediationImpl => ({
  plan: async () => change(summary, [spec.argv.join(' ')], packages),
  apply: async (rt, row, targetId) =>
    withPve(rt, async (pve) => {
      await runRegistered(handleFor(rt, pve, targetNode(row, targetId), quiet()), spec, false);
    }),
  validate: async (rt, row, targetId) => !(await stillReported(rt, targetNode(row, targetId), key)),
});

const SYSCTL_D = '/etc/sysctl.d/99-velnox-from-sysctl-conf.conf';
const isSetting = (line: string) => line.trim() !== '' && !/^\s*[#;]/.test(line);

export const PVE_REMEDIATION_IMPLS: Record<string, RemediationImpl> = {
  'pve.microcode': {
    plan: async (_rt, _row, _targetId, finding) => {
      const pkg =
        finding.params?.package === 'amd64-microcode' ? 'amd64-microcode' : 'intel-microcode';
      return change(
        `enable Debian's non-free-firmware component and install ${pkg}`,
        [microcodeCommand(pkg).argv.join(' ')],
        { install: [pkg] },
      );
    },
    apply: async (rt, row, targetId, approved) => {
      // The package in the stored change set — what was routed is what runs.
      const pkg =
        approved.packages.install[0] === 'amd64-microcode' ? 'amd64-microcode' : 'intel-microcode';
      await withPve(rt, async (pve) => {
        await runRegistered(
          handleFor(rt, pve, targetNode(row, targetId), quiet()),
          microcodeCommand(pkg),
          false,
        );
      });
    },
    validate: async (rt, row, targetId) =>
      !(await stillReported(rt, targetNode(row, targetId), 'pve8to9.microcode-missing')),
  },
  'pve.sysctl-move': {
    // The exact files before and after, read from the node, are what is approved.
    plan: async (rt, row, targetId) =>
      withPve(rt, async (pve) => {
        const node = targetNode(row, targetId);
        const before = (
          await runRegistered(handleFor(rt, pve, node, quiet()), PVE_COMMANDS.sysctlRead, false)
        ).stdout;
        const lines = before.replace(/\n$/, '').split('\n');
        const after = lines
          .map((l) => (isSetting(l) ? `# moved to ${SYSCTL_D}: ${l}` : l))
          .join('\n');
        const moved = lines.filter(isSetting).join('\n');
        return change(
          `move the settings in /etc/sysctl.conf to ${SYSCTL_D}`,
          [PVE_COMMANDS.sysctlMove.argv.join(' ')],
          {},
          [
            { path: '/etc/sysctl.conf', before: lines.join('\n'), after },
            { path: SYSCTL_D, before: null, after: moved },
          ],
        );
      }),
    apply: async (rt, row, targetId) =>
      withPve(rt, async (pve) => {
        await runRegistered(
          handleFor(rt, pve, targetNode(row, targetId), quiet()),
          PVE_COMMANDS.sysctlMove,
          false,
        );
      }),
    validate: async (rt, row, targetId) =>
      !(await stillReported(rt, targetNode(row, targetId), 'pve8to9.sysctl-conf')),
  },
  'pve.remove-systemd-boot': commandRemediation(
    'pve8to9.systemd-boot',
    PVE_COMMANDS.removeSystemdBoot,
    'remove the systemd-boot meta-package (systemd-boot-efi and systemd-boot-tools stay)',
    { remove: ['systemd-boot'] },
  ),
  'pve.install-grub-efi': commandRemediation(
    'pve8to9.grub-efi',
    PVE_COMMANDS.installGrubEfi,
    'install grub-efi-amd64',
    { install: ['grub-efi-amd64'] },
  ),
  'pve.grub-removable': commandRemediation(
    'pve8to9.grub-removable',
    PVE_COMMANDS.grubRemovable,
    'let GRUB keep the removable EFI bootloader up to date, and reinstall it',
  ),
  'pve.lvm-autoactivation': commandRemediation(
    'pve8to9.lvm-autoactivation',
    PVE_COMMANDS.lvmAutoactivation,
    "run Proxmox's script that disables autoactivation of existing LVM guest volumes",
  ),
  'pve.update-bookworm': {
    plan: async (_rt, _row, _targetId, finding) =>
      change(
        `apt-get update and dist-upgrade on bookworm, to the latest Proxmox VE 8${
          finding.params?.version
            ? ` (now pve-manager ${finding.params.version}; pve8to9 needs ${PVE8TO9_FROM} or later)`
            : ''
        }`,
        ['apt-get update', 'apt-get dist-upgrade'],
      ),
    apply: async (rt, row, targetId) =>
      withPve(rt, async (pve) => {
        const handle = handleFor(rt, pve, targetNode(row, targetId), quiet());
        await refreshLists(handle);
        await distUpgrade(handle);
      }),
    validate: async (rt, row, targetId) => {
      const node = targetNode(row, targetId);
      // pve-manager restarts its API on the update: give it a moment to answer.
      const version = await settledVersion(rt, node);
      if (!hasPve8to9(version)) return false;
      return (
        !(await stillReported(rt, node, 'pve8to9.pve-too-old')) &&
        !(await stillReported(rt, node, 'pve8to9.updates-pending'))
      );
    },
  },
};

// ---------------------------------------------------------------------------
// Node by node
// ---------------------------------------------------------------------------

interface Move {
  vmid: number;
  kind: 'qemu' | 'lxc';
  from: string;
  to: string;
}
interface Stopped {
  vmid: number;
  kind: 'qemu' | 'lxc';
  node: string;
}
const label = (g: { vmid: number; kind: string }) => `${g.kind === 'lxc' ? 'CT' : 'VM'} ${g.vmid}`;

async function stepOutput(rt: UpgradeRuntime, key: string): Promise<Record<string, unknown>> {
  const row = await rt.prisma.jobStep.findUnique({
    where: { jobId_stepKey: { jobId: rt.jobId, stepKey: key } },
    select: { output: true },
  });
  return (row?.output ?? {}) as Record<string, unknown>;
}

async function setTarget(
  rt: UpgradeRuntime,
  target: TargetRow,
  data: Parameters<UpgradeRuntime['prisma']['upgradeTarget']['update']>[0]['data'],
) {
  await rt.prisma.upgradeTarget.update({ where: { id: target.id }, data });
}

async function skipIfDone(
  pve: ProxmoxClient,
  target: TargetRow,
  context: StepContext,
  what: string,
): Promise<boolean> {
  const now = await nodeVersion(pve, target.label);
  if (!onNine(now.version)) return false;
  await context.log(
    'STDOUT',
    `${target.label} already runs Proxmox VE ${now.version}; ${what} not needed`,
  );
  return true;
}

export const PVE_ACTIONS: Record<string, UpgradeAction> = {
  'pve.facts': async ({ rt, context }) => {
    const row = await plan(rt);
    await withPve(rt, async (pve) => {
      const ceph = (await runningVersions(pve).catch(() => new Map())).size > 0;
      const versions: Record<string, string | null> = {};
      for (const t of row.targets) versions[t.label] = (await nodeVersion(pve, t.label)).version;
      await mergeFacts(rt, {
        pveUpgrade: { ceph, nooutSetByVelnox: pveFacts(row).nooutSetByVelnox } satisfies PveFacts,
        pve: { versions },
      });
      await context.log(
        'STDOUT',
        `Nodes: ${Object.entries(versions)
          .map(([n, v]) => `${n} ${v}`)
          .join(', ')}${ceph ? '; Ceph present' : ''}`,
      );
    });
    await rt.prisma.upgradePlan.update({
      where: { id: row.id },
      data: { status: 'RUNNING', startedAt: row.startedAt ?? new Date() },
    });
  },

  /**
   * Every node too old for pve8to9 gets its update to the latest Proxmox VE 8
   * planned — waiting for approval in the next step, applied in the one after.
   * pve8to9 runs only once every node has it.
   */
  'pve.latest-8': async ({ rt, context }) => {
    const row = await plan(rt);
    const def = UPGRADE_REMEDIATIONS['pve.update-bookworm']!;
    const impl = PVE_REMEDIATION_IMPLS['pve.update-bookworm']!;
    // Running this step again after a crash replaces what it planned, nothing else.
    await rt.prisma.remediationRun.deleteMany({
      where: { planId: row.id, status: 'PLANNED', checkKey: 'pve.pve8to9-missing' },
    });
    const behind: string[] = [];
    await withPve(rt, async (pve) => {
      for (const target of row.targets) {
        const { version } = await nodeVersion(pve, target.label);
        if (hasPve8to9(version)) continue;
        const finding = pve8to9Missing(target.id, target.label, version);
        const planned = await impl.plan(rt, row, target.id, finding);
        await rt.prisma.remediationRun.create({
          data: {
            tenantId: row.tenantId,
            planId: row.id,
            targetId: target.id,
            checkKey: finding.key,
            remediationId: def.id,
            risk: def.risk,
            mode: routeRemediation(def),
            changeSet: planned as unknown as Prisma.InputJsonValue,
          },
        });
        behind.push(`${target.label} ${version ?? '?'}`);
      }
    });
    await context.log(
      'STDOUT',
      behind.length
        ? `Too old for pve8to9 (${PVE8TO9_FROM}+), brought to the latest Proxmox VE 8 first after approval: ${behind.join(', ')}`
        : `Every node has pve8to9 (pve-manager ${PVE8TO9_FROM} or later)`,
    );
    return { behind: behind.length };
  },

  /** Every running guest moved off the node, within the placement rules. */
  'pve.evacuate': async ({ rt, target, context }) => {
    if (!target) return;
    const row = await plan(rt);
    const options = optionsOf(row);
    return withPve(rt, async (pve) => {
      const before = await nodeVersion(pve, target.label);
      await setTarget(rt, target, {
        status: 'RUNNING',
        startedAt: new Date(),
        preState: { version: before.version, kernel: before.kernel },
      });
      if (onNine(before.version)) {
        await context.log('STDOUT', `${target.label} already runs Proxmox VE ${before.version}`);
        return { moves: '[]', stopped: '[]' };
      }
      const resources = await pve.clusterResources();
      const shared = await sharedStorages(rt.prisma, rt.params.clusterId);
      const guests = (await assessGuests(pve, resources, [target.label], shared)).sort(
        (a, b) => b.memoryBytes - a.memoryBytes,
      );
      const free = freeMemory(resources);
      const away = new Set([target.label]);
      const rules = await placementRulesOf(rt.prisma, rt.params.clusterId);
      const positions = positionsOf(resources);
      for (const g of guests) positions.delete(g.vmid);
      const moves: Move[] = [];
      const stopped: Stopped[] = [];
      const record = () => ({ moves: JSON.stringify(moves), stopped: JSON.stringify(stopped) });
      try {
        for (const guest of guests) {
          if (guest.blocker) {
            if (options.nonMigratable !== 'SHUTDOWN') {
              throw new StepError(
                ERROR_CODES.updateNotMigratable,
                `${label(guest)} on ${target.label} cannot be moved (${guest.blocker})`,
                { guests: label(guest) },
              );
            }
            await context.log(
              'STDOUT',
              `Shutting ${label(guest)} down on ${target.label}: it cannot move (${guest.blocker})`,
            );
            const upid = await pve.guestCommand(guest.node, guest.kind, guest.vmid, 'shutdown');
            const outcome = await waitForTask(pve, upid, {
              signal: context.signal,
              timeoutMs: 10 * 60_000,
            });
            if (!outcome.succeeded)
              throw new StepError(
                ERROR_CODES.updateMigrationFailed,
                `Shutting ${label(guest)} down failed`,
                { vmid: guest.vmid, from: guest.node, to: guest.node },
              );
            stopped.push({ vmid: guest.vmid, kind: guest.kind, node: guest.node });
            continue;
          }
          const to = chooseTarget(
            guest as PlannedGuest,
            free,
            away,
            (n) => !placementForbids(rules, positions, guest.vmid, n),
            (n) => placementRank(rules, guest.vmid, n),
          );
          if (!to)
            throw new StepError(
              ERROR_CODES.updateCapacityShort,
              `No node may take ${label(guest)} while ${target.label} upgrades`,
              { node: target.label, neededGb: 0, freeGb: 0 },
            );
          await context.log('STDOUT', `Moving ${label(guest)} from ${target.label} to ${to}`);
          await moveGuest(
            pve,
            context.signal,
            { vmid: guest.vmid, kind: guest.kind, from: guest.node, to },
            ERROR_CODES.updateMigrationFailed,
          );
          positions.set(guest.vmid, to);
          moves.push({ vmid: guest.vmid, kind: guest.kind, from: guest.node, to });
        }
      } catch (error) {
        await rt.prisma.jobStep.update({
          where: { jobId_stepKey: { jobId: rt.jobId, stepKey: `evacuate-${target.sequence}` } },
          data: { output: record() },
        });
        throw error;
      }
      await context.log(
        'STDOUT',
        `${target.label} is empty: ${moves.length} moved, ${stopped.length} shut down`,
      );
      return record();
    });
  },

  'pve.repositories': async ({ rt, target, context }) => {
    if (!target) return;
    await withPve(rt, async (pve) => {
      if (await skipIfDone(pve, target, context, 'the sources')) return;
      const out = await runRegistered(
        handleFor(rt, pve, target.label, context),
        PVE_COMMANDS.sourcesTrixie,
        false,
      );
      await context.log('STDOUT', `${target.label}: sources on trixie\n${out.stdout.trim()}`);
    });
  },

  'pve.dist-upgrade': async ({ rt, target, context }) => {
    if (!target) return;
    await withPve(rt, async (pve) => {
      if (await skipIfDone(pve, target, context, 'the dist-upgrade')) return;
      const handle = handleFor(rt, pve, target.label, context);
      await refreshLists(handle);
      await distUpgrade(handle);
    });
  },

  /** The reboot — with Ceph's noout set around it, and only while quorum allows. */
  'pve.reboot': async ({ rt, target, context }) => {
    if (!target) return;
    const row = await plan(rt);
    const facts = pveFacts(row);
    await withPve(rt, async (pve) => {
      const now = await nodeVersion(pve, target.label);
      if (onNine(now.version) && now.kernel && !now.kernel.startsWith('6.8')) {
        await context.log(
          'STDOUT',
          `${target.label} already runs Proxmox VE ${now.version} on ${now.kernel}`,
        );
        return;
      }
      if (
        facts.ceph &&
        !(await pve.cephFlags()).some((f) => f.name === 'noout' && Number(f.value) === 1)
      ) {
        await mergeFacts(rt, { pveUpgrade: { ...facts, nooutSetByVelnox: true } });
        await pve.setCephFlag('noout', true);
        await context.log('STDOUT', 'noout set for the reboot');
      }
      const handle = handleFor(rt, pve, target.label, context);
      const quorum = await quorumAllows(pve, 1);
      if (!quorum.ok) {
        throw new StepError(
          ERROR_CODES.clusterQuorumAtRisk,
          `Rebooting ${target.label} would leave the cluster without quorum (${quorum.online} of ${quorum.total} online)`,
          {
            cluster: target.label,
            available: quorum.online - 1,
            required: Math.floor(quorum.total / 2) + 1,
          },
        );
      }
      await rebootIfNeeded(handle, 'ALWAYS', 1);
    });
  },

  /** On Proxmox VE 9 and its new kernel, the cluster whole, pve8to9 clean. */
  'pve.validate': async ({ rt, target, context }) => {
    if (!target) return;
    const row = await plan(rt);
    const options = optionsOf(row);
    await withPve(rt, async (pve) => {
      const deadline = Date.now() + options.rebootMinutes * 60_000;
      let now = await nodeVersion(pve, target.label).catch(() => ({ version: null, kernel: null }));
      while (!onNine(now.version) && Date.now() < deadline) {
        await context.sleep(5000);
        now = await nodeVersion(pve, target.label).catch(() => ({ version: null, kernel: null }));
      }
      const fail = async (why: string) => {
        await setTarget(rt, target, {
          status: 'FAILED',
          finishedAt: new Date(),
          postState: { version: now.version, kernel: now.kernel },
        });
        throw new StepError(ERROR_CODES.upgradeTargetFailed, `${target.label}: ${why}`, {
          target: target.label,
        });
      };
      if (!onNine(now.version))
        await fail(`runs ${now.version ?? 'nothing'} after its upgrade, not Proxmox VE 9`);
      if (!now.kernel || now.kernel.startsWith('6.8'))
        await fail(`still runs kernel ${now.kernel ?? 'unknown'} after its reboot`);
      const facts = pveFacts(await plan(rt));
      if (facts.ceph) {
        let health = assessCephHealth((await pve.cephStatus()) as unknown as CephStatusLike, true);
        while (!health.ok && !health.unknown.length && Date.now() < deadline) {
          await context.sleep(3000);
          health = assessCephHealth((await pve.cephStatus()) as unknown as CephStatusLike, true);
        }
        if (!health.ok)
          await fail(`Ceph is not whole: ${[...health.unknown, ...health.problems].join('; ')}`);
        if (facts.nooutSetByVelnox) {
          await pve.setCephFlag('noout', false);
          await mergeFacts(rt, { pveUpgrade: { ...facts, nooutSetByVelnox: false } });
          await context.log('STDOUT', 'noout cleared');
        }
      }
      const { findings } = await runPve8to9(rt, pve, target.label, context);
      const stopping = findings.filter(
        (f) => f && (f.severity === 'BLOCKER' || f.severity === 'UNKNOWN'),
      );
      if (stopping.length)
        await fail(`pve8to9 after the upgrade: ${stopping.map((f) => f!.title).join('; ')}`);
      await setTarget(rt, target, { postState: { version: now.version, kernel: now.kernel } });
      await context.log(
        'STDOUT',
        `${target.label} runs Proxmox VE ${now.version} on ${now.kernel}; pve8to9 has nothing that stops`,
      );
    });
  },

  /** Guests back where they came from; those shut down started again. */
  'pve.return': async ({ rt, target, context }) => {
    if (!target) return;
    const out = await stepOutput(rt, `evacuate-${target.sequence}`);
    const moves = typeof out.moves === 'string' ? (JSON.parse(out.moves) as Move[]) : [];
    const stopped = typeof out.stopped === 'string' ? (JSON.parse(out.stopped) as Stopped[]) : [];
    const rules = await placementRulesOf(rt.prisma, rt.params.clusterId);
    const left: string[] = [];
    await withPve(rt, async (pve) => {
      for (const m of moves) {
        const positions = positionsOf(await pve.clusterResources());
        if (positions.get(m.vmid) !== m.to) {
          left.push(`${label(m)} is no longer on ${m.to}`);
          continue;
        }
        positions.delete(m.vmid);
        const forbids = placementForbids(rules, positions, m.vmid, m.from);
        if (forbids) {
          left.push(`${label(m)} stays on ${m.to}: placement rule "${forbids.name}"`);
          continue;
        }
        await context.log('STDOUT', `Moving ${label(m)} back from ${m.to} to ${m.from}`);
        await moveGuest(
          pve,
          context.signal,
          { ...m, from: m.to, to: m.from },
          ERROR_CODES.updateMigrationFailed,
        );
      }
      for (const s of stopped) {
        await context.log('STDOUT', `Starting ${label(s)} on ${s.node} again`);
        const upid = await pve.guestCommand(s.node, s.kind, s.vmid, 'start');
        const outcome = await waitForTask(pve, upid, {
          signal: context.signal,
          timeoutMs: 10 * 60_000,
        });
        if (!outcome.succeeded) left.push(`${label(s)} on ${s.node} did not start`);
      }
    });
    for (const line of left) await context.log('STDERR', line);
    await setTarget(rt, target, { status: 'DONE', finishedAt: new Date() });
    return { returned: moves.length + stopped.length - left.length, left: left.length };
  },

  'pve.final': async ({ rt, context }) => {
    const row = await plan(rt);
    await withPve(rt, async (pve) => {
      const behind: string[] = [];
      for (const t of row.targets) {
        const v = await nodeVersion(pve, t.label);
        if (!onNine(v.version)) behind.push(`${t.label} ${v.version}`);
      }
      if (behind.length) {
        throw new StepError(
          ERROR_CODES.upgradeTargetFailed,
          `Not every node runs Proxmox VE 9: ${behind.join(', ')}`,
          { target: behind.join(', ') },
        );
      }
      await context.log(
        'STDOUT',
        'Every node runs Proxmox VE 9. HA groups become HA rules by themselves now that every node does.',
      );
    });
  },
};

/** Clear noout if Velnox set it for a reboot — after a failure, a cancel or a dead worker. */
export async function pveCleanup(rt: UpgradeRuntime): Promise<void> {
  const row = await plan(rt);
  const facts = pveFacts(row);
  if (!facts.nooutSetByVelnox) return;
  await withPve(rt, (pve) => pve.setCephFlag('noout', false));
  await mergeFacts(rt, { pveUpgrade: { ...facts, nooutSetByVelnox: false } });
}

/** For a version string such as pve-manager's: at least 8.4.0. */
export const pveAtLeast = (version: string | null, min: string) =>
  Boolean(version && compareVersions(version, min) >= 0);

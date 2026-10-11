import { waitForTask, type ProxmoxClient } from '@velnox/proxmox';
import {
  ERROR_CODES,
  PERMISSIONS,
  REBOOT_POLICIES,
  maxUnavailableNodes,
  newerKernelInstalled,
  windowState,
  type NodeUpdateParams,
} from '@velnox/shared';
import { installedKernelVersions } from '@velnox/proxmox';
import { StepError, type Playbook, type StepContext, type StepDefinition } from '../jobs/steps';
import type { LibraryServices } from '../library/services';
import type { SshTarget } from '../library/ssh';
import {
  COMMANDS,
  WRONG_NODE_EXIT,
  parseAptSimulate,
  parseRebootRequired,
} from '../remote/commands';
import { CommandTimeoutError, lineBuffer, runCommand } from '../remote/exec';
import { refreshNodeUpdates } from './refresh';

/**
 * node.update — apply one node's pending updates (Phase 6).
 *
 *   check     the cluster has quorum, the node is online, SSH can reach it
 *   approve   (when its policy asks) waits for someone with updates.execute
 *   window    (when its policy has one) the window is open, or nothing changes
 *   refresh   apt-get update, through Proxmox's API
 *   simulate  what a dist-upgrade would do, read over SSH, classified
 *   upgrade   apt-get dist-upgrade over SSH, its output in the job as it runs;
 *             not interruptible — a cancel waits for it to finish
 *   reboot    when the policy says so: only if the cluster keeps quorum
 *             without this node, then waits for it to come back on the new kernel
 *   verify    reads what is left, and whether a reboot is still due
 *
 * Nothing here can be undone — apt has no rollback — so the steps before
 * `upgrade` are where it refuses, and the job says plainly what it changed.
 */

const REBOOT_TIMEOUT_MS = 20 * 60_000;
const REBOOT_POLL_MS = 5_000;

export function parseNodeUpdateParams(raw: unknown): NodeUpdateParams {
  const v = raw as Partial<NodeUpdateParams> | null;
  const uuid = /^[0-9a-f-]{36}$/i;
  if (
    !v ||
    typeof v.clusterId !== 'string' ||
    !uuid.test(v.clusterId) ||
    typeof v.nodeId !== 'string' ||
    !uuid.test(v.nodeId) ||
    typeof v.node !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(v.node) ||
    !REBOOT_POLICIES.includes(v.rebootPolicy as never)
  ) {
    throw new StepError(
      ERROR_CODES.validation,
      'node.update needs a cluster, a node and a reboot policy',
    );
  }
  return {
    clusterId: v.clusterId,
    nodeId: v.nodeId,
    node: v.node,
    rebootPolicy: v.rebootPolicy!,
    requireApproval: v.requireApproval === true,
    maintenanceWindowId: typeof v.maintenanceWindowId === 'string' ? v.maintenanceWindowId : null,
    policyId: typeof v.policyId === 'string' ? v.policyId : null,
    pending: {
      total: Number(v.pending?.total ?? 0),
      security: Number(v.pending?.security ?? 0),
      kernel: Number(v.pending?.kernel ?? 0),
      proxmox: Number(v.pending?.proxmox ?? 0),
    },
  };
}

/** Whether the cluster keeps quorum with `leaving` more nodes down. */
export async function quorumAllows(
  client: ProxmoxClient,
  leaving: number,
): Promise<{ ok: boolean; total: number; online: number; quorate: boolean }> {
  const status = await client.clusterStatus();
  const nodes = status.filter((row) => row.type === 'node');
  const cluster = status.find((row) => row.type === 'cluster');
  const total = nodes.length;
  const online = nodes.filter((row) => row.online === 1).length;
  // A standalone node has no cluster row and no quorum to keep.
  if (!cluster || total <= 1) return { ok: true, total, online, quorate: true };
  const quorate = cluster.quorate === 1;
  const down = total - online + leaving;
  return { ok: quorate && down <= maxUnavailableNodes(total), total, online, quorate };
}

export function nodeUpdatePlaybook(raw: unknown, services: LibraryServices): Playbook {
  const params = parseNodeUpdateParams(raw);
  const { prisma } = services;
  let client: ProxmoxClient | null = null;
  let target: SshTarget | null = null;

  const connect = async (): Promise<ProxmoxClient> => {
    client ??= (await services.connect(params.clusterId)).client;
    return client;
  };
  const ssh = async (): Promise<SshTarget> => {
    if (target) return target;
    try {
      target = await services.sshTarget(params.clusterId, params.node);
    } catch (error) {
      throw new StepError(
        ERROR_CODES.updateSshRequired,
        `SSH is not set up for ${params.node}: ${error instanceof Error ? error.message : 'unknown'}`,
        { node: params.node },
      );
    }
    return target;
  };

  /** Run a registered command, its output into the job's log, refusing a failure. */
  const run = async (
    context: StepContext,
    spec: (typeof COMMANDS)[keyof typeof COMMANDS],
    echo: boolean,
  ) => {
    const buffer = lineBuffer((stream, text) => context.log(stream, text));
    let result;
    try {
      result = await runCommand(await ssh(), spec, params.node, {
        signal: context.signal,
        onOutput: echo ? buffer.push : undefined,
      });
    } catch (error) {
      await buffer.flush();
      if (error instanceof CommandTimeoutError) {
        throw new StepError(ERROR_CODES.updateCommandFailed, error.message, {
          command: spec.id,
          exitCode: -1,
        });
      }
      throw error;
    }
    await buffer.flush();
    if (result.exitCode === WRONG_NODE_EXIT) {
      throw new StepError(
        ERROR_CODES.updateCommandFailed,
        `The machine reached for ${params.node} is not called ${params.node}; nothing was run`,
        { command: spec.id, exitCode: WRONG_NODE_EXIT },
      );
    }
    if (result.exitCode !== 0) {
      if (!echo && result.stderr) await context.log('STDERR', result.stderr.slice(-4000));
      throw new StepError(
        ERROR_CODES.updateCommandFailed,
        `${spec.id} on ${params.node} ended with exit code ${result.exitCode}`,
        { command: spec.id, exitCode: result.exitCode ?? -1 },
      );
    }
    return result;
  };

  const steps: StepDefinition[] = [
    {
      kind: 'task',
      key: 'check',
      phase: 'preflight',
      run: async (context) => {
        const pve = await connect();
        const quorum = await quorumAllows(pve, 0);
        if (!quorum.quorate) {
          throw new StepError(ERROR_CODES.updateNotQuorate, 'The cluster has no quorum', {
            online: quorum.online,
            total: quorum.total,
          });
        }
        const resources = await pve.clusterResources();
        const node = resources.find((r) => r.type === 'node' && r.node === params.node);
        if (!node || node.status !== 'online') {
          throw new StepError(ERROR_CODES.nodeOffline, `${params.node} is not online`, {
            node: params.node,
          });
        }
        await ssh();
        const guests = resources.filter(
          (r) =>
            (r.type === 'qemu' || r.type === 'lxc') &&
            r.node === params.node &&
            r.status === 'running',
        );
        await context.log(
          'STDOUT',
          `Updating ${params.node}: ${params.pending.total} pending (${params.pending.security} security, ${params.pending.kernel} kernel); reboot ${params.rebootPolicy.toLowerCase().replace('_', ' ')}. ${guests.length} guest${guests.length === 1 ? '' : 's'} running on it.`,
        );
        return { online: quorum.online, total: quorum.total, guests: guests.length };
      },
    },
  ];

  if (params.requireApproval) {
    steps.push({
      kind: 'approval',
      key: 'approve',
      phase: 'preflight',
      requiredPermission: PERMISSIONS.updatesExecute,
      reason: 'The update policy asks for approval before a node is updated',
      requireDifferentApprover: false,
      changeSet: {
        node: params.node,
        packages: params.pending.total,
        security: params.pending.security,
        kernel: params.pending.kernel,
        reboot: params.rebootPolicy,
      },
    });
  }

  if (params.maintenanceWindowId) {
    steps.push({
      kind: 'task',
      key: 'window',
      phase: 'preflight',
      run: async (context) => {
        const window = await prisma.maintenanceWindow.findUnique({
          where: { id: params.maintenanceWindowId! },
        });
        if (!window) {
          throw new StepError(
            ERROR_CODES.updateWindowClosed,
            'The maintenance window no longer exists',
          );
        }
        const state = windowState(window, Date.now());
        if (!state.open) {
          throw new StepError(
            ERROR_CODES.updateWindowClosed,
            `Window "${window.name}" is not open; nothing was changed`,
            {
              window: window.name,
              nextOpening: state.nextOpening ? new Date(state.nextOpening).toISOString() : null,
            },
          );
        }
        await context.log(
          'STDOUT',
          `Window "${window.name}" is open until ${new Date(state.closesAt!).toISOString()}`,
        );
        return { window: window.name };
      },
    });
  }

  steps.push(
    {
      kind: 'task',
      key: 'refresh',
      phase: 'apply',
      run: async (context) => {
        const pve = await connect();
        const upid = await pve.refreshUpdates(params.node);
        const outcome = await waitForTask(pve, upid, {
          signal: context.signal,
          timeoutMs: 10 * 60_000,
        });
        if (!outcome.succeeded) {
          throw new StepError(
            ERROR_CODES.updateCommandFailed,
            `apt-get update failed: ${outcome.exitStatus}`,
            {
              command: 'apt.update',
              exitCode: -1,
            },
          );
        }
        await context.log('STDOUT', 'Package lists refreshed');
      },
    },
    {
      kind: 'task',
      key: 'simulate',
      phase: 'apply',
      run: async (context) => {
        const result = await run(context, COMMANDS.aptSimulate, false);
        const installs = parseAptSimulate(result.stdout);
        const security = installs.filter((i) => /security/i.test(i.archive ?? ''));
        for (const install of installs) {
          await context.log(
            'STDOUT',
            `  ${install.package} ${install.currentVersion ?? '(new)'} → ${install.candidateVersion}${install.archive ? ` [${install.archive}]` : ''}`,
          );
        }
        await context.log(
          'STDOUT',
          `${installs.length} package${installs.length === 1 ? '' : 's'} to install, ${security.length} from a security archive`,
        );
        return { packages: installs.length, security: security.length };
      },
    },
    {
      kind: 'task',
      key: 'upgrade',
      phase: 'apply',
      run: async (context) => {
        await context.log(
          'STDOUT',
          'Running apt-get dist-upgrade; a cancel waits for it to finish',
        );
        await run(context, COMMANDS.aptDistUpgrade, true);
        await context.log('STDOUT', 'dist-upgrade finished');
      },
    },
    {
      kind: 'task',
      key: 'reboot',
      phase: 'apply',
      run: async (context) => {
        const pve = await connect();
        const marker = parseRebootRequired(
          (await run(context, COMMANDS.rebootRequired, false)).stdout,
        );
        const [status, versions] = await Promise.all([
          pve.nodeStatus(params.node),
          pve.nodePackageVersions(params.node),
        ]);
        const running = status['current-kernel']?.release ?? null;
        const newer = newerKernelInstalled(running, installedKernelVersions(versions));
        const required = marker.required || newer !== null;
        const reason = newer
          ? `kernel ${newer} is installed, ${running} is running`
          : marker.required
            ? `the node asks for it (${marker.packages.join(', ') || 'no package named'})`
            : null;

        if (
          params.rebootPolicy === 'NEVER' ||
          (params.rebootPolicy === 'IF_REQUIRED' && !required)
        ) {
          await context.log(
            'STDOUT',
            required
              ? `A reboot is due (${reason}); the policy does not reboot`
              : 'No reboot needed',
          );
          return { rebooted: false, required };
        }

        const quorum = await quorumAllows(pve, 1);
        if (!quorum.ok) {
          throw new StepError(
            ERROR_CODES.updateNotQuorate,
            `Rebooting ${params.node} would leave the cluster without quorum (${quorum.online} of ${quorum.total} online); updates are installed, the reboot was not done`,
            { online: quorum.online, total: quorum.total },
          );
        }
        const uptimeBefore = status.uptime ?? Number.MAX_SAFE_INTEGER;
        await context.log('STDOUT', `Rebooting ${params.node}${reason ? `: ${reason}` : ''}`);
        await pve.nodeCommand(params.node, 'reboot');

        const started = Date.now();
        let wentDown = false;
        for (;;) {
          await context.sleep(REBOOT_POLL_MS);
          const now = await pve.nodeStatus(params.node).catch(() => null);
          if (!now) wentDown = true;
          else if ((now.uptime ?? Number.MAX_SAFE_INTEGER) < uptimeBefore) {
            await context.log(
              'STDOUT',
              `${params.node} is back, running ${now['current-kernel']?.release ?? 'an unknown kernel'}`,
            );
            break;
          }
          if (Date.now() - started > REBOOT_TIMEOUT_MS) {
            throw new StepError(
              ERROR_CODES.updateRebootTimeout,
              `${params.node} did not come back within ${REBOOT_TIMEOUT_MS / 60_000} minutes${wentDown ? '' : ' (it was never seen going down)'}`,
              { node: params.node, minutes: REBOOT_TIMEOUT_MS / 60_000 },
            );
          }
        }
        return { rebooted: true, required };
      },
    },
    {
      kind: 'task',
      key: 'verify',
      phase: 'verify',
      run: async (context) => {
        const pve = await connect();
        const after = await refreshNodeUpdates(prisma, pve, params.nodeId, params.node);
        await context.log(
          after.total === 0 ? 'STDOUT' : 'STDERR',
          after.total === 0
            ? `${params.node} has no pending updates`
            : `${params.node} still has ${after.total} pending update${after.total === 1 ? '' : 's'} (held back, or new since)`,
        );
        if (after.rebootRequired)
          await context.log('STDOUT', `A reboot is still due: ${after.reason}`);
        return {
          pending: after.total,
          rebootRequired: after.rebootRequired,
          kernel: after.runningKernel,
        };
      },
    },
  );

  return {
    version: 1,
    steps,
    async cleanup() {
      (client as ProxmoxClient | null)?.close();
    },
  };
}

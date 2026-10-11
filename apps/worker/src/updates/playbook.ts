import type { ProxmoxClient } from '@velnox/proxmox';
import {
  ERROR_CODES,
  PERMISSIONS,
  REBOOT_POLICIES,
  windowState,
  type NodeUpdateParams,
} from '@velnox/shared';
import { StepError, type Playbook, type StepContext, type StepDefinition } from '../jobs/steps';
import type { LibraryServices } from '../library/services';
import {
  distUpgrade,
  rebootIfNeeded,
  refreshLists,
  simulate,
  sshFor,
  type NodeHandle,
} from './node-ops';
import { quorumAllows } from './quorum';
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

export function nodeUpdatePlaybook(raw: unknown, services: LibraryServices): Playbook {
  const params = parseNodeUpdateParams(raw);
  const { prisma } = services;
  let client: ProxmoxClient | null = null;
  const ssh = sshFor(services, params.clusterId, params.node);

  const connect = async (): Promise<ProxmoxClient> => {
    client ??= (await services.connect(params.clusterId)).client;
    return client;
  };
  const handle = async (context: StepContext): Promise<NodeHandle> => ({
    node: params.node,
    pve: await connect(),
    signal: context.signal,
    log: context.log,
    sleep: context.sleep,
    ssh,
  });

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
        await refreshLists(await handle(context));
      },
    },
    {
      kind: 'task',
      key: 'simulate',
      phase: 'apply',
      run: async (context) => simulate(await handle(context)),
    },
    {
      kind: 'task',
      key: 'upgrade',
      phase: 'apply',
      run: async (context) => {
        await distUpgrade(await handle(context));
      },
    },
    {
      kind: 'task',
      key: 'reboot',
      phase: 'apply',
      run: async (context) => rebootIfNeeded(await handle(context), params.rebootPolicy, 1),
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

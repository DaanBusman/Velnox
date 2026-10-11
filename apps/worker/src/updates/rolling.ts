import { waitForTask, type ClusterResource, type ProxmoxClient } from '@velnox/proxmox';
import {
  ERROR_CODES,
  NON_MIGRATABLE_POLICIES,
  PERMISSIONS,
  REBOOT_POLICIES,
  maxUnavailableNodes,
  windowState,
  type PlannedGuest,
  type RollingUpdateParams,
} from '@velnox/shared';
import {
  PartialStop,
  StepError,
  type Playbook,
  type StepContext,
  type StepDefinition,
} from '../jobs/steps';
import type { LibraryServices } from '../library/services';
import { assessGuests, chooseTarget, freeMemory, sharedStorages } from './guests';
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
 * cluster.rolling_update — every node of a cluster, group after group (Phase 7).
 *
 *   preflight   refuses a cluster already degraded (a node down, quorum gone,
 *               Ceph not HEALTH_OK), a group larger than quorum allows, a guest
 *               that cannot be moved when the request says to block on one, and
 *               a group whose guests would not fit on the other nodes
 *   approve     when the cluster's policy asks
 *   window      when it has one; checked again before every group
 *   per group:
 *     evacuate  running guests moved live to other nodes (containers by
 *               restart); one that cannot move is shut down when allowed
 *     update    refresh, simulate and dist-upgrade on each node of the group
 *     reboot    per the reboot policy, if quorum allows with the group away
 *     validate  the group's nodes are back, the cluster is whole and quorate,
 *               Ceph is HEALTH_OK — waited for up to `settleMinutes`
 *     return    guests moved back where they came from, shut-down ones started
 *   summary     every guest moved, and where each is now
 *
 * A group that fails after an earlier one finished stops the run as
 * PARTIALLY_SUCCEEDED: the finished nodes are finished. Every failure names
 * the guests that were moved and not returned, and where they are.
 */

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

export function parseRollingParams(raw: unknown): RollingUpdateParams & { settleMinutes: number } {
  const v = raw as Partial<RollingUpdateParams & { settleMinutes: number }> | null;
  const name = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;
  if (
    !v ||
    typeof v.clusterId !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(v.clusterId) ||
    !Array.isArray(v.groups) ||
    v.groups.length === 0 ||
    !v.groups.every(
      (g) =>
        Array.isArray(g) && g.length > 0 && g.every((n) => typeof n === 'string' && name.test(n)),
    ) ||
    !REBOOT_POLICIES.includes(v.rebootPolicy as never) ||
    !NON_MIGRATABLE_POLICIES.includes(v.nonMigratable as never)
  ) {
    throw new StepError(
      ERROR_CODES.validation,
      'cluster.rolling_update needs a cluster and its groups',
    );
  }
  return {
    clusterId: v.clusterId,
    groups: v.groups,
    nodeIds: (v.nodeIds ?? {}) as Record<string, string>,
    rebootPolicy: v.rebootPolicy!,
    nonMigratable: v.nonMigratable!,
    migrateBack: v.migrateBack !== false,
    requireApproval: v.requireApproval === true,
    maintenanceWindowId: typeof v.maintenanceWindowId === 'string' ? v.maintenanceWindowId : null,
    policyId: typeof v.policyId === 'string' ? v.policyId : null,
    settleMinutes: Math.min(60, Math.max(1, Number(v.settleMinutes ?? 10))),
  };
}

const prefixed =
  (context: StepContext, node: string) => (stream: 'STDOUT' | 'STDERR', text: string) =>
    context.log(
      stream,
      text
        .split('\n')
        .map((line) => `[${node}] ${line}`)
        .join('\n'),
    );

const guestLabel = (g: { vmid: number; kind: string }) =>
  `${g.kind === 'lxc' ? 'CT' : 'VM'} ${g.vmid}`;

export function rollingUpdatePlaybook(
  raw: unknown,
  jobId: string,
  services: LibraryServices,
): Playbook {
  const params = parseRollingParams(raw);
  const { prisma } = services;
  let client: ProxmoxClient | null = null;
  const ssh = new Map(
    params.groups.flat().map((node) => [node, sshFor(services, params.clusterId, node)]),
  );

  const connect = async (): Promise<ProxmoxClient> => {
    client ??= (await services.connect(params.clusterId)).client;
    return client;
  };
  const handle = async (context: StepContext, node: string): Promise<NodeHandle> => ({
    node,
    pve: await connect(),
    signal: context.signal,
    log: prefixed(context, node),
    sleep: context.sleep,
    ssh: ssh.get(node)!,
  });

  /** What an earlier step of this job recorded — moves survive a pause for approval. */
  const output = async (stepKey: string): Promise<Record<string, unknown>> => {
    const row = await prisma.jobStep.findUnique({
      where: { jobId_stepKey: { jobId, stepKey } },
      select: { output: true },
    });
    return (row?.output ?? {}) as Record<string, unknown>;
  };
  const movesOf = async (group: number): Promise<{ moves: Move[]; stopped: Stopped[] }> => {
    const out = await output(`g${group}-evacuate`);
    return {
      moves: typeof out.moves === 'string' ? (JSON.parse(out.moves) as Move[]) : [],
      stopped: typeof out.stopped === 'string' ? (JSON.parse(out.stopped) as Stopped[]) : [],
    };
  };
  const returnedOf = async (group: number): Promise<number[]> => {
    const out = await output(`g${group}-return`);
    return typeof out.returned === 'string' ? (JSON.parse(out.returned) as number[]) : [];
  };

  /** Every guest moved and not (yet) moved back, and where it is. */
  const unaccounted = async (upTo: number): Promise<string> => {
    const lines: string[] = [];
    for (let g = 1; g <= upTo; g += 1) {
      const { moves, stopped } = await movesOf(g);
      const back = new Set(await returnedOf(g));
      for (const m of moves)
        if (!back.has(m.vmid)) lines.push(`${guestLabel(m)} is on ${m.to} (came from ${m.from})`);
      for (const s of stopped)
        if (!back.has(s.vmid))
          lines.push(`${guestLabel(s)} on ${s.node} was shut down and not started`);
    }
    return lines.length ? ` Guests not returned: ${lines.join('; ')}.` : '';
  };

  /** A group's failure: partial when an earlier group finished. */
  const unit = async <T>(group: number, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof StepError) || error instanceof PartialStop) throw error;
      const tail = await unaccounted(group).catch(() => '');
      if (group > 1) throw new PartialStop(error.code, `${error.message}.${tail}`, error.params);
      throw new StepError(error.code, `${error.message}.${tail}`, error.params);
    }
  };

  const migrate = async (context: StepContext, pve: ProxmoxClient, g: Move): Promise<void> => {
    const upid = await pve.migrateGuest(g.from, g.kind, g.vmid, g.to);
    const outcome = await waitForTask(pve, upid, {
      signal: context.signal,
      timeoutMs: 30 * 60_000,
    });
    if (!outcome.succeeded) {
      throw new StepError(
        ERROR_CODES.updateMigrationFailed,
        `Moving ${guestLabel(g)} from ${g.from} to ${g.to} failed: ${outcome.exitStatus}`,
        {
          vmid: g.vmid,
          from: g.from,
          to: g.to,
        },
      );
    }
    const after = await pve.clusterResources();
    const where = after.find(
      (r) => r.vmid === g.vmid && (r.type === 'qemu' || r.type === 'lxc'),
    )?.node;
    if (where !== g.to) {
      throw new StepError(
        ERROR_CODES.updateMigrationFailed,
        `${guestLabel(g)} is on ${where ?? 'no node'} after moving it to ${g.to}`,
        {
          vmid: g.vmid,
          from: g.from,
          to: g.to,
        },
      );
    }
  };

  const cephHealth = async (pve: ProxmoxClient): Promise<string | null> => {
    try {
      const status = await pve.cephStatus();
      return status.health?.status ?? null;
    } catch {
      return null; // no Ceph on this cluster
    }
  };

  const steps: StepDefinition[] = [
    {
      kind: 'task',
      key: 'preflight',
      phase: 'preflight',
      run: async (context) => {
        const pve = await connect();
        const status = await pve.clusterStatus();
        const nodes = status.filter((row) => row.type === 'node');
        const cluster = status.find((row) => row.type === 'cluster');
        const down = nodes.filter((row) => row.online !== 1).map((row) => row.name);
        if (cluster && cluster.quorate !== 1) {
          throw new StepError(ERROR_CODES.updateClusterDegraded, 'The cluster has no quorum', {
            reason: 'no quorum',
          });
        }
        if (down.length) {
          throw new StepError(
            ERROR_CODES.updateClusterDegraded,
            `${down.join(', ')} ${down.length === 1 ? 'is' : 'are'} offline`,
            {
              reason: `${down.join(', ')} offline`,
            },
          );
        }
        const health = await cephHealth(pve);
        if (health && health !== 'HEALTH_OK') {
          throw new StepError(ERROR_CODES.updateClusterDegraded, `Ceph is ${health}`, {
            reason: `Ceph is ${health}`,
          });
        }
        const allowed = nodes.length <= 1 ? 1 : maxUnavailableNodes(nodes.length);
        const largest = Math.max(...params.groups.map((g) => g.length));
        if (largest > allowed) {
          throw new StepError(
            ERROR_CODES.updatePlanRefused,
            `A group of ${largest} is more than the ${allowed} quorum allows down`,
            {
              reason: `${largest} > ${allowed}`,
            },
          );
        }
        for (const node of params.groups.flat()) await ssh.get(node)!();

        const resources = await pve.clusterResources();
        const shared = await sharedStorages(prisma, params.clusterId);
        const guests = await assessGuests(pve, resources, params.groups.flat(), shared);
        const blocked = guests.filter((g) => g.blocker);
        for (const g of guests) {
          await context.log(
            'STDOUT',
            `${guestLabel(g)}${g.name ? ` (${g.name})` : ''} on ${g.node}: ${g.blocker ? `cannot move — ${g.blocker}` : 'can move live'}`,
          );
        }
        if (blocked.length && params.nonMigratable === 'BLOCK') {
          throw new StepError(
            ERROR_CODES.updateNotMigratable,
            `Running guests that cannot be moved: ${blocked.map((g) => `${guestLabel(g)} on ${g.node} (${g.blocker})`).join('; ')}`,
            { guests: blocked.map((g) => guestLabel(g)).join(', ') },
          );
        }
        const free = freeMemory(resources);
        for (const group of params.groups) {
          const away = new Set(group);
          const needed = guests
            .filter((g) => away.has(g.node) && !g.blocker)
            .reduce((sum, g) => sum + g.memoryBytes, 0);
          const room = [...free]
            .filter(([node]) => !away.has(node))
            .reduce((sum, [, bytes]) => sum + bytes, 0);
          if (needed > room) {
            throw new StepError(
              ERROR_CODES.updateCapacityShort,
              `The guests of ${group.join(', ')} need ${gb(needed)} GB; the other nodes have ${gb(room)} GB free`,
              {
                node: group.join(', '),
                neededGb: gb(needed),
                freeGb: gb(room),
              },
            );
          }
        }
        await context.log(
          'STDOUT',
          `Updating ${params.groups.flat().length} node${params.groups.flat().length === 1 ? '' : 's'} in ${params.groups.length} group${params.groups.length === 1 ? '' : 's'}: ${params.groups.map((g) => g.join('+')).join(' → ')}`,
        );
        return { groups: params.groups.length, guests: guests.length, blocked: blocked.length };
      },
    },
  ];

  if (params.requireApproval) {
    steps.push({
      kind: 'approval',
      key: 'approve',
      phase: 'preflight',
      requiredPermission: PERMISSIONS.updatesExecute,
      reason: 'The update policy asks for approval before a cluster is updated',
      requireDifferentApprover: false,
      changeSet: {
        nodes: params.groups.map((g) => g.join('+')).join(' → '),
        reboot: params.rebootPolicy,
        nonMigratable: params.nonMigratable,
      },
    });
  }

  const checkWindow = async (context: StepContext, group: number) => {
    if (!params.maintenanceWindowId) return;
    const window = await prisma.maintenanceWindow.findUnique({
      where: { id: params.maintenanceWindowId },
    });
    const state = window ? windowState(window, Date.now()) : null;
    if (!window || !state?.open) {
      const message = `Window "${window?.name ?? 'gone'}" is not open`;
      if (group > 1)
        throw new PartialStop(
          ERROR_CODES.updateWindowClosed,
          `${message}; stopped before group ${group}`,
          { window: window?.name ?? null },
        );
      throw new StepError(ERROR_CODES.updateWindowClosed, `${message}; nothing was changed`, {
        window: window?.name ?? null,
      });
    }
    await context.log(
      'STDOUT',
      `Window "${window.name}" is open until ${new Date(state.closesAt!).toISOString()}`,
    );
  };

  params.groups.forEach((group, index) => {
    const g = index + 1;
    const label = group.join('+');
    steps.push(
      {
        kind: 'task',
        key: `g${g}-evacuate`,
        phase: 'apply',
        run: (context) =>
          unit(g, async () => {
            await checkWindow(context, g);
            const pve = await connect();
            const resources = await pve.clusterResources();
            const shared = await sharedStorages(prisma, params.clusterId);
            const guests = (await assessGuests(pve, resources, group, shared)).sort(
              (a, b) => b.memoryBytes - a.memoryBytes,
            );
            const free = freeMemory(resources);
            const away = new Set(group);
            const moves: Move[] = [];
            const stopped: Stopped[] = [];
            const record = async () => ({
              moves: JSON.stringify(moves),
              stopped: JSON.stringify(stopped),
            });
            try {
              for (const guest of guests) {
                if (guest.blocker) {
                  if (params.nonMigratable !== 'SHUTDOWN') {
                    throw new StepError(
                      ERROR_CODES.updateNotMigratable,
                      `${guestLabel(guest)} on ${guest.node} cannot be moved (${guest.blocker})`,
                      {
                        guests: guestLabel(guest),
                      },
                    );
                  }
                  await context.log(
                    'STDOUT',
                    `Shutting ${guestLabel(guest)} down on ${guest.node}: it cannot move (${guest.blocker})`,
                  );
                  const upid = await pve.guestCommand(
                    guest.node,
                    guest.kind,
                    guest.vmid,
                    'shutdown',
                  );
                  const outcome = await waitForTask(pve, upid, {
                    signal: context.signal,
                    timeoutMs: 10 * 60_000,
                  });
                  if (!outcome.succeeded) {
                    throw new StepError(
                      ERROR_CODES.updateMigrationFailed,
                      `Shutting ${guestLabel(guest)} down failed: ${outcome.exitStatus}`,
                      {
                        vmid: guest.vmid,
                        from: guest.node,
                        to: guest.node,
                      },
                    );
                  }
                  stopped.push({ vmid: guest.vmid, kind: guest.kind, node: guest.node });
                  continue;
                }
                const to = chooseTarget(guest as PlannedGuest, free, away);
                if (!to) {
                  throw new StepError(
                    ERROR_CODES.updateCapacityShort,
                    `No node outside ${label} has room for ${guestLabel(guest)}`,
                    {
                      node: label,
                      neededGb: gb(guest.memoryBytes),
                      freeGb: 0,
                    },
                  );
                }
                const move: Move = { vmid: guest.vmid, kind: guest.kind, from: guest.node, to };
                await context.log(
                  'STDOUT',
                  `Moving ${guestLabel(guest)} from ${guest.node} to ${to}${guest.kind === 'lxc' ? ' (a container restarts there)' : ''}`,
                );
                await migrate(context, pve, move);
                moves.push(move);
              }
            } catch (error) {
              // What moved before the failure is recorded, so it is accounted for.
              await prisma.jobStep.update({
                where: { jobId_stepKey: { jobId, stepKey: `g${g}-evacuate` } },
                data: { output: await record() },
              });
              throw error;
            }
            await context.log(
              'STDOUT',
              `${label} is empty: ${moves.length} moved, ${stopped.length} shut down`,
            );
            return { ...(await record()), moved: moves.length, shutDown: stopped.length };
          }),
      },
      {
        kind: 'task',
        key: `g${g}-update`,
        phase: 'apply',
        run: (context) =>
          unit(g, async () => {
            await Promise.all(
              group.map(async (node) => {
                const h = await handle(context, node);
                await refreshLists(h);
                await simulate(h);
                await distUpgrade(h);
              }),
            );
          }),
      },
      {
        kind: 'task',
        key: `g${g}-reboot`,
        phase: 'apply',
        run: (context) =>
          unit(g, async () => {
            const results = await Promise.all(
              group.map(async (node) =>
                rebootIfNeeded(await handle(context, node), params.rebootPolicy, group.length),
              ),
            );
            return { rebooted: results.filter((r) => r.rebooted).length };
          }),
      },
      {
        kind: 'task',
        key: `g${g}-validate`,
        phase: 'verify',
        run: async (context) => {
          const pve = await connect();
          const deadline = Date.now() + params.settleMinutes * 60_000;
          let problem = '';
          for (;;) {
            problem = '';
            const resources = await pve.clusterResources().catch(() => [] as ClusterResource[]);
            for (const node of group) {
              const row = resources.find((r) => r.type === 'node' && r.node === node);
              if (!row || row.status !== 'online') problem = `${node} is not online`;
            }
            if (!problem) {
              const quorum = await quorumAllows(pve, 0).catch(() => null);
              if (!quorum || !quorum.quorate) problem = 'the cluster has no quorum';
              else if (quorum.online < quorum.total)
                problem = `${quorum.total - quorum.online} node(s) are offline`;
            }
            if (!problem) {
              const health = await cephHealth(pve);
              if (health && health !== 'HEALTH_OK') problem = `Ceph is ${health}`;
            }
            if (!problem) break;
            if (Date.now() > deadline) break;
            await context.sleep(5_000);
          }
          if (problem) {
            const tail = await unaccounted(g).catch(() => '');
            const message = `${label} did not validate within ${params.settleMinutes} minute${params.settleMinutes === 1 ? '' : 's'}: ${problem}; the run stops here.${tail}`;
            if (g > 1)
              throw new PartialStop(ERROR_CODES.updateValidationFailed, message, {
                node: label,
                reason: problem,
              });
            throw new StepError(ERROR_CODES.updateValidationFailed, message, {
              node: label,
              reason: problem,
            });
          }
          for (const node of group) {
            const id = params.nodeIds[node];
            if (id) await refreshNodeUpdates(prisma, pve, id, node).catch(() => undefined);
          }
          await context.log('STDOUT', `${label} is back and the cluster is whole`);
        },
      },
      {
        kind: 'task',
        key: `g${g}-return`,
        phase: 'verify',
        run: async (context) => {
          const pve = await connect();
          const { moves, stopped } = await movesOf(g);
          const returned: number[] = [];
          const notReturned: string[] = [];
          if (params.migrateBack) {
            for (const move of moves) {
              const resources = await pve.clusterResources();
              const now = resources.find(
                (r) => r.vmid === move.vmid && (r.type === 'qemu' || r.type === 'lxc'),
              );
              if (!now || now.node !== move.to || now.status !== 'running') {
                notReturned.push(
                  `${guestLabel(move)} is on ${now?.node ?? 'no node'} (${now?.status ?? 'gone'}), not moved back`,
                );
                continue;
              }
              await context.log(
                'STDOUT',
                `Moving ${guestLabel(move)} back from ${move.to} to ${move.from}`,
              );
              try {
                await migrate(context, pve, { ...move, from: move.to, to: move.from });
                returned.push(move.vmid);
              } catch (error) {
                notReturned.push(
                  `${guestLabel(move)} stays on ${move.to}: ${error instanceof Error ? error.message : 'unknown'}`,
                );
              }
            }
          } else {
            for (const move of moves)
              notReturned.push(`${guestLabel(move)} stays on ${move.to}, as asked`);
          }
          for (const s of stopped) {
            await context.log('STDOUT', `Starting ${guestLabel(s)} on ${s.node} again`);
            const upid = await pve.guestCommand(s.node, s.kind, s.vmid, 'start');
            const outcome = await waitForTask(pve, upid, {
              signal: context.signal,
              timeoutMs: 10 * 60_000,
            }).catch(() => null);
            if (outcome?.succeeded) returned.push(s.vmid);
            else
              notReturned.push(
                `${guestLabel(s)} on ${s.node} did not start: ${outcome?.exitStatus ?? 'no answer'}`,
              );
          }
          for (const line of notReturned) await context.log('STDERR', line);
          return { returned: JSON.stringify(returned), notReturned: notReturned.length };
        },
      },
    );
  });

  steps.push({
    kind: 'task',
    key: 'summary',
    phase: 'verify',
    run: async (context) => {
      let moved = 0;
      let back = 0;
      const pve = await connect();
      const resources = await pve.clusterResources();
      for (let g = 1; g <= params.groups.length; g += 1) {
        const { moves, stopped } = await movesOf(g);
        const returned = new Set(await returnedOf(g));
        for (const m of [...moves, ...stopped.map((s) => ({ ...s, from: s.node, to: s.node }))]) {
          moved += 1;
          const now = resources.find(
            (r) => r.vmid === m.vmid && (r.type === 'qemu' || r.type === 'lxc'),
          );
          if (returned.has(m.vmid)) back += 1;
          await context.log(
            returned.has(m.vmid) ? 'STDOUT' : 'STDERR',
            `${guestLabel(m)}: ${returned.has(m.vmid) ? 'back on' : 'now on'} ${now?.node ?? 'no node'} (${now?.status ?? 'gone'})`,
          );
        }
      }
      await context.log(
        'STDOUT',
        `${params.groups.flat().length} nodes updated; ${moved} guests moved or shut down, ${back} back where they were`,
      );
      return { nodes: params.groups.flat().length, moved, returned: back };
    },
  });

  return {
    version: 1,
    steps,
    async cleanup() {
      (client as ProxmoxClient | null)?.close();
    },
  };
}

const gb = (bytes: number) => Math.round((bytes / 1024 ** 3) * 10) / 10;

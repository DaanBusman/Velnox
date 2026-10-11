import type { ProxmoxClient } from '@velnox/proxmox';
import {
  ERROR_CODES,
  PLACEMENT_REASONS,
  placementForbids,
  placementViolations,
  planBalance,
  planCorrections,
  type MovableGuest,
  type PlacementJobParams,
  type PlannedMove,
} from '@velnox/shared';
import { PartialStop, StepError, type Playbook } from '../jobs/steps';
import type { LibraryServices } from '../library/services';
import {
  assessGuests,
  freeMemory,
  moveGuest,
  placementRulesOf,
  positionsOf,
  sharedStorages,
} from '../updates/guests';

/**
 * cluster.placement — move guests to meet the cluster's placement rules, or
 * one guest to even out memory (Phase 7B).
 *
 *   check   the cluster is whole: quorate, every node online, Ceph HEALTH_OK.
 *           Placement moves nothing on a cluster that is not.
 *   plan    from what Proxmox says now: the moves that meet the rules without
 *           breaking another, or the one move that narrows the spread of
 *           memory use past the threshold; what cannot be met is said
 *   move    each move in turn, checked against the rules again just before
 *   verify  the rules read again; any still not met are reported
 *
 * Moves made before a failure stand: the job ends PARTIALLY_SUCCEEDED and
 * says which were made.
 */

export function parsePlacementParams(raw: unknown): PlacementJobParams {
  const v = raw as Partial<PlacementJobParams> | null;
  if (
    !v ||
    typeof v.clusterId !== 'string' ||
    !PLACEMENT_REASONS.includes(v.reason as PlacementJobParams['reason'])
  ) {
    throw new StepError(ERROR_CODES.validation, 'A placement job needs a cluster and a reason');
  }
  return {
    clusterId: v.clusterId,
    reason: v.reason as PlacementJobParams['reason'],
    by: typeof v.by === 'string' ? v.by : null,
    balanceThresholdPercent: Math.min(80, Math.max(5, Number(v.balanceThresholdPercent ?? 20))),
  };
}

const guestLabel = (g: { vmid: number; kind: string }) =>
  `${g.kind === 'lxc' ? 'CT' : 'VM'} ${g.vmid}`;

export function placementPlaybook(
  raw: unknown,
  jobId: string,
  services: LibraryServices,
): Playbook {
  const params = parsePlacementParams(raw);
  const { prisma } = services;
  let client: ProxmoxClient | null = null;
  const connect = async (): Promise<ProxmoxClient> => {
    client ??= (await services.connect(params.clusterId)).client;
    return client;
  };
  const planned = async (): Promise<PlannedMove[]> => {
    const row = await prisma.jobStep.findUnique({
      where: { jobId_stepKey: { jobId, stepKey: 'plan' } },
      select: { output: true },
    });
    const out = (row?.output ?? {}) as Record<string, unknown>;
    return typeof out.moves === 'string' ? (JSON.parse(out.moves) as PlannedMove[]) : [];
  };

  return {
    version: 1,
    steps: [
      {
        kind: 'task',
        key: 'check',
        phase: 'preflight',
        run: async (context) => {
          const pve = await connect();
          const status = await pve.clusterStatus();
          const cluster = status.find((row) => row.type === 'cluster');
          const down = status
            .filter((row) => row.type === 'node' && row.online !== 1)
            .map((row) => row.name);
          let reason: string | null = null;
          if (cluster && cluster.quorate !== 1) reason = 'no quorum';
          else if (down.length) reason = `${down.join(', ')} offline`;
          else {
            const health = await pve
              .cephStatus()
              .then((s) => s.health?.status ?? null)
              .catch(() => null);
            if (health && health !== 'HEALTH_OK') reason = `Ceph is ${health}`;
          }
          if (reason) {
            throw new StepError(
              ERROR_CODES.placementClusterDegraded,
              `The cluster is not whole (${reason}); placement moves nothing`,
              { reason },
            );
          }
          await context.log('STDOUT', 'The cluster is whole: quorate, every node online');
          return { whole: true };
        },
      },
      {
        kind: 'task',
        key: 'plan',
        phase: 'preflight',
        run: async (context) => {
          const pve = await connect();
          const resources = await pve.clusterResources();
          const rules = await placementRulesOf(prisma, params.clusterId);
          const online = resources
            .filter((r) => r.type === 'node' && r.status === 'online' && r.node)
            .map((r) => r.node!);
          const shared = await sharedStorages(prisma, params.clusterId);
          const guests: MovableGuest[] = await assessGuests(pve, resources, online, shared);
          const positions = positionsOf(resources);
          const before = placementViolations(rules, positions);
          for (const v of before) {
            await context.log(
              v.soft ? 'STDOUT' : 'STDERR',
              `Rule "${v.ruleName}" not met${v.soft ? ' (a preference)' : ''}: ${v.message}`,
            );
          }

          let moves: PlannedMove[] = [];
          let unresolved: string[] = [];
          if (params.reason === 'correct') {
            if (!before.length) await context.log('STDOUT', 'Every placement rule holds');
            ({ moves, unresolved } = planCorrections(rules, guests, freeMemory(resources)));
          } else {
            const loads = resources
              .filter((r) => r.type === 'node' && r.status === 'online' && r.node)
              .map((r) => ({ node: r.node!, totalBytes: r.maxmem ?? 0, usedBytes: r.mem ?? 0 }));
            const result = planBalance(rules, guests, loads, params.balanceThresholdPercent);
            await context.log(
              'STDOUT',
              `Memory use differs by ${result.spreadPercent.toFixed(1)} points between the busiest and the quietest node; the threshold is ${params.balanceThresholdPercent}`,
            );
            if (result.move) moves = [result.move];
          }
          for (const m of moves) {
            await context.log(
              'STDOUT',
              `Plan: ${guestLabel(m)} from ${m.from} to ${m.to}${m.reason === 'balance' ? ', to even out memory' : ` for rule "${m.reason}"`}`,
            );
          }
          for (const line of unresolved) await context.log('STDERR', `Cannot be met: ${line}`);
          if (!moves.length) await context.log('STDOUT', 'Nothing to move');
          return {
            moves: JSON.stringify(moves),
            unresolved: JSON.stringify(unresolved),
            violations: before.length,
          };
        },
      },
      {
        kind: 'task',
        key: 'move',
        phase: 'apply',
        run: async (context) => {
          const moves = await planned();
          const done: PlannedMove[] = [];
          const pve = await connect();
          const rules = await placementRulesOf(prisma, params.clusterId);
          for (const move of moves) {
            const positions = positionsOf(await pve.clusterResources());
            const now = positions.get(move.vmid);
            if (now !== move.from) {
              await context.log(
                'STDOUT',
                `${guestLabel(move)} is no longer running on ${move.from}; left alone`,
              );
              continue;
            }
            positions.delete(move.vmid);
            const forbids = placementForbids(rules, positions, move.vmid, move.to);
            if (forbids) {
              await context.log(
                'STDERR',
                `${guestLabel(move)} not moved: on ${move.to} it would now break rule "${forbids.name}"`,
              );
              continue;
            }
            await context.log(
              'STDOUT',
              `Moving ${guestLabel(move)} from ${move.from} to ${move.to}${move.kind === 'lxc' ? ' (a container restarts there)' : ''}`,
            );
            try {
              await moveGuest(pve, context.signal, move, ERROR_CODES.placementMigrationFailed);
            } catch (error) {
              if (done.length && error instanceof StepError && !(error instanceof PartialStop)) {
                throw new PartialStop(
                  error.code,
                  `${error.message}. Moved before it: ${done.map((d) => `${guestLabel(d)} to ${d.to}`).join(', ')}`,
                  error.params,
                );
              }
              throw error;
            }
            done.push(move);
          }
          return { moved: done.length, moves: JSON.stringify(done) };
        },
      },
      {
        kind: 'task',
        key: 'verify',
        phase: 'verify',
        run: async (context) => {
          const pve = await connect();
          const rules = await placementRulesOf(prisma, params.clusterId);
          const after = placementViolations(rules, positionsOf(await pve.clusterResources()));
          const hard = after.filter((v) => !v.soft);
          for (const v of after) {
            await context.log(
              v.soft ? 'STDOUT' : 'STDERR',
              `Still not met: rule "${v.ruleName}"${v.soft ? ' (a preference)' : ''}: ${v.message}`,
            );
          }
          if (params.reason === 'correct' && hard.length) {
            const moved = (await planned()).length;
            const message = `${hard.length} placement rule${hard.length === 1 ? ' is' : 's are'} still not met: ${hard.map((v) => `"${v.ruleName}" (${v.message})`).join('; ')}`;
            const errorParams = { rules: hard.map((v) => v.ruleName).join(', ') };
            if (moved) throw new PartialStop(ERROR_CODES.placementUnresolved, message, errorParams);
            throw new StepError(ERROR_CODES.placementUnresolved, message, errorParams);
          }
          if (!after.length) await context.log('STDOUT', 'Every placement rule holds');
          return { violations: after.length };
        },
      },
    ],
    async cleanup() {
      (client as ProxmoxClient | null)?.close();
    },
  };
}

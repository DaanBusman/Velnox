import type { Queue } from 'bullmq';
import { appendJobEvent, withSystemScope, type Prisma, type VelnoxPrismaClient } from '@velnox/db';
import type { HaRule } from '@velnox/proxmox';
import {
  ACTIVE_JOB_STATUSES,
  JOB_EVENT_KEYS,
  JOB_TYPES,
  haRuleFor,
  haRuleId,
  hasHaRules,
  placementViolations,
  type PlacementJobParams,
  type PlacementReason,
} from '@velnox/shared';
import type { LibraryServices } from '../library/services';

/**
 * Keeping placement (Phase 7B), every half minute:
 *
 * - On a cluster whose nodes all run PVE 9, each rule is one of Proxmox's HA
 *   rules, `velnox-<id>`. Velnox writes it, reads it back, and writes it
 *   again if someone changed or removed it in Proxmox: Velnox's rule is the
 *   one that counts. A rule removed in Velnox is removed there, then here.
 *   On PVE 8, where there are no HA rules, a removed rule goes at once.
 * - A cluster whose settings correct placement by itself gets a correction
 *   job when the inventory shows a rule not met; one that balances gets a
 *   balancing job when memory use differs by more than its threshold. Never
 *   while the cluster is not whole or busy with another job, and never within
 *   its quiet period of the last job started here.
 */

export const PLACEMENT_INTERVAL_MS = 30_000;

const sorted = (list: string | undefined) =>
  (list ?? '')
    .split(',')
    .map((s) => s.trim().replace(/:\d+$/, ''))
    .filter(Boolean)
    .sort()
    .join(',');

/** Whether Proxmox holds the rule as Velnox would write it. */
export function sameHaRule(have: HaRule, want: Record<string, string | number>): boolean {
  return (
    have.type === want.type &&
    sorted(have.resources) === sorted(String(want.resources)) &&
    Number(have.disable ?? 0) === Number(want.disable ?? 0) &&
    (want.type === 'node-affinity'
      ? sorted(have.nodes) === sorted(String(want.nodes)) &&
        Number(have.strict ?? 0) === Number(want.strict)
      : have.affinity === want.affinity)
  );
}

export async function syncHaRules(
  prisma: VelnoxPrismaClient,
  services: LibraryServices,
  clusterId: string,
): Promise<{ written: number; removed: number }> {
  const rows = await prisma.placementRule.findMany({ where: { clusterId } });
  if (!rows.length) return { written: 0, removed: 0 };
  const workloads = await prisma.workload.findMany({
    where: { clusterId },
    select: { vmid: true, kind: true },
  });
  const kinds = Object.fromEntries(
    workloads.map((w) => [w.vmid, w.kind === 'LXC' ? 'lxc' : 'qemu']),
  ) as Record<number, 'qemu' | 'lxc'>;
  const { client: pve } = await services.connect(clusterId);
  let written = 0;
  let removed = 0;
  try {
    let current: HaRule[];
    try {
      current = await pve.haRules();
    } catch (error) {
      const message = `Proxmox's HA rules could not be read: ${error instanceof Error ? error.message : 'unknown'}`;
      for (const row of rows.filter((r) => !r.deletedAt && r.haSyncError !== message)) {
        await prisma.placementRule.update({
          where: { id: row.id },
          data: { haSyncError: message, updatedAt: row.updatedAt },
        });
      }
      return { written, removed };
    }
    const byId = new Map(current.map((r) => [r.rule, r]));
    const errors = new Map<string, string>();
    const wrote = new Set<string>();
    for (const row of rows) {
      const id = haRuleId(row.id);
      try {
        if (row.deletedAt) {
          if (byId.has(id)) await pve.deleteHaRule(id);
          await prisma.placementRule.delete({ where: { id: row.id } });
          removed += 1;
          continue;
        }
        const want = haRuleFor({ ...row, kinds });
        const have = byId.get(id);
        if (!have) await pve.createHaRule(id, want);
        else if (!sameHaRule(have, want)) await pve.updateHaRule(id, want);
        else continue;
        wrote.add(row.id);
        written += 1;
      } catch (error) {
        errors.set(row.id, error instanceof Error ? error.message : 'unknown');
      }
    }
    // Read back what Proxmox now holds: written is not the same as kept.
    const after = new Map((await pve.haRules()).map((r) => [r.rule, r]));
    for (const row of rows) {
      if (row.deletedAt) continue;
      const id = haRuleId(row.id);
      const held = after.get(id);
      const ok = held !== undefined && sameHaRule(held, haRuleFor({ ...row, kinds }));
      const error = errors.get(row.id) ?? (ok ? null : 'Proxmox does not hold the rule as written');
      const current =
        ok &&
        !wrote.has(row.id) &&
        row.haRuleId === id &&
        row.haSyncError === null &&
        row.haSyncedAt !== null &&
        row.haSyncedAt >= row.updatedAt;
      if (current || (!ok && row.haSyncError === error)) continue;
      // `updatedAt` stays the last change a person made: held is "since then".
      await prisma.placementRule.update({
        where: { id: row.id },
        data: ok
          ? { haRuleId: id, haSyncedAt: new Date(), haSyncError: null, updatedAt: row.updatedAt }
          : { haSyncError: error, updatedAt: row.updatedAt },
      });
    }
  } finally {
    pve.close();
  }
  return { written, removed };
}

async function start(
  prisma: VelnoxPrismaClient,
  queue: Queue,
  cluster: { id: string; name: string; tenantId: string },
  reason: PlacementReason,
  threshold: number,
): Promise<string | null> {
  const params: PlacementJobParams = {
    clusterId: cluster.id,
    reason,
    by: 'placement settings',
    balanceThresholdPercent: threshold,
  };
  let jobId: string;
  try {
    const job = await prisma.job.create({
      data: {
        tenantId: cluster.tenantId,
        type: JOB_TYPES.placement,
        params: params as unknown as Prisma.InputJsonValue,
        concurrencyKey: `cluster:${cluster.id}`,
        targetKind: 'cluster',
        targetIds: [cluster.id],
        parentJobId: null,
        createdByUserId: null,
      },
      select: { id: true },
    });
    jobId = job.id;
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'P2002') return null;
    throw error;
  }
  const what = reason === 'correct' ? 'to meet its placement rules' : 'to even out memory';
  await appendJobEvent(prisma, jobId, {
    level: 'INFO',
    key: JOB_EVENT_KEYS.queued,
    message: `Queued by the placement settings of ${cluster.name}, ${what}`,
    data: { by: 'placement settings', reason },
  });
  await prisma.auditEvent.create({
    data: {
      action: 'job.created',
      result: 'SUCCESS',
      actorType: 'SCHEDULER',
      actorLabel: `placement settings ${cluster.name}`,
      tenantId: cluster.tenantId,
      resourceType: 'job',
      resourceId: jobId,
      resourceLabel: JOB_TYPES.placement,
      metadata: { reason, cluster: cluster.name },
    },
  });
  await queue.add('run', { jobId }, { jobId: `${jobId}-${Date.now()}` });
  return jobId;
}

export async function keepPlacement(
  prisma: VelnoxPrismaClient,
  queue: Queue,
  services: LibraryServices,
  now = new Date(),
): Promise<{ synced: string[]; started: string[]; failed: string[] }> {
  return withSystemScope('placement is kept on its own schedule', async () => {
    const synced: string[] = [];
    const started: string[] = [];
    const failed: string[] = [];

    const withRules = await prisma.cluster.findMany({
      where: { placementRules: { some: {} } },
      select: { id: true, name: true, pveVersions: true, connectionState: true },
    });
    for (const cluster of withRules) {
      if (!hasHaRules(cluster.pveVersions)) {
        await prisma.placementRule.deleteMany({
          where: { clusterId: cluster.id, deletedAt: { not: null } },
        });
        continue;
      }
      try {
        const result = await syncHaRules(prisma, services, cluster.id);
        if (result.written || result.removed) synced.push(cluster.name);
      } catch {
        failed.push(cluster.name);
      }
    }

    const settings = await prisma.placementSettings.findMany({
      where: { OR: [{ autoCorrect: true }, { balance: true }] },
      include: {
        cluster: {
          select: {
            id: true,
            name: true,
            tenantId: true,
            quorate: true,
            nodes: {
              select: { name: true, state: true, memoryTotalBytes: true, memoryUsedBytes: true },
            },
          },
        },
      },
    });
    for (const s of settings) {
      const cluster = s.cluster;
      const whole =
        cluster.quorate !== false &&
        cluster.nodes.length > 0 &&
        cluster.nodes.every((n) => n.state === 'ONLINE');
      if (!whole) continue;
      const busy = await prisma.job.findFirst({
        where: {
          concurrencyKey: `cluster:${cluster.id}`,
          status: { in: [...ACTIVE_JOB_STATUSES] },
        },
        select: { id: true },
      });
      if (busy) continue;
      const recent = await prisma.job.findFirst({
        where: {
          type: JOB_TYPES.placement,
          targetIds: { has: cluster.id },
          createdByUserId: null,
          queuedAt: { gte: new Date(now.getTime() - s.quietMinutes * 60_000) },
        },
        select: { id: true },
      });
      if (recent) continue;

      if (s.autoCorrect) {
        const rules = await prisma.placementRule.findMany({
          where: { clusterId: cluster.id, enabled: true, deletedAt: null },
        });
        if (rules.length) {
          const running = await prisma.workload.findMany({
            where: { clusterId: cluster.id, state: 'RUNNING', template: false },
            select: { vmid: true, node: { select: { name: true } } },
          });
          const positions = new Map(
            running.filter((w) => w.node).map((w) => [w.vmid, w.node!.name]),
          );
          if (placementViolations(rules, positions).some((v) => !v.soft)) {
            const id = await start(prisma, queue, cluster, 'correct', s.balanceThresholdPercent);
            if (id) started.push(id);
            continue;
          }
        }
      }
      if (s.balance) {
        const pct = cluster.nodes
          .filter((n) => n.memoryTotalBytes && n.memoryTotalBytes > 0n)
          .map((n) => (Number(n.memoryUsedBytes ?? 0n) / Number(n.memoryTotalBytes)) * 100);
        if (pct.length > 1 && Math.max(...pct) - Math.min(...pct) > s.balanceThresholdPercent) {
          const id = await start(prisma, queue, cluster, 'balance', s.balanceThresholdPercent);
          if (id) started.push(id);
        }
      }
    }
    return { synced, started, failed };
  });
}

import type { Queue } from 'bullmq';
import { appendJobEvent, withSystemScope, type Prisma, type VelnoxPrismaClient } from '@velnox/db';
import {
  ACTIVE_JOB_STATUSES,
  JOB_EVENT_KEYS,
  JOB_TYPES,
  windowState,
  type NodeUpdateParams,
} from '@velnox/shared';

/**
 * Update policies that update by themselves (Phase 6).
 *
 * Every minute: for each enabled policy with `autoApply` whose window is open
 * now, start an update for one online node of its cluster that has pending
 * updates and that no policy has started an update for in this opening of the
 * window — so a node whose update failed is tried once per opening, not every
 * minute. One node at
 * a time per cluster — the cluster's concurrency key holds the next until the
 * last has finished, rebooted and come back. Outside the window nothing is
 * started, and a job whose window closes before it reaches the upgrade stops
 * there (updates/playbook.ts, the `window` step).
 *
 * A job started here has no creator; its first event says which policy
 * started it, and the audit log records it under the policy.
 */

export const UPDATE_SCHEDULER_INTERVAL_MS = 60_000;

export async function scheduleUpdates(
  prisma: VelnoxPrismaClient,
  queue: Queue,
  now = new Date(),
): Promise<{ started: string[] }> {
  return withSystemScope('update policies run on their own schedule', async () => {
    const started: string[] = [];
    const policies = await prisma.updatePolicy.findMany({
      where: { enabled: true, autoApply: true, maintenanceWindowId: { not: null } },
      include: { window: true, cluster: { select: { id: true, name: true, tenantId: true } } },
    });
    for (const policy of policies) {
      if (!policy.window) continue;
      const state = windowState(policy.window, now.getTime());
      if (!state.open || state.openedAt === null) continue;

      const busy = await prisma.job.findFirst({
        where: {
          concurrencyKey: `cluster:${policy.clusterId}`,
          status: { in: [...ACTIVE_JOB_STATUSES] },
        },
        select: { id: true },
      });
      if (busy) continue;

      const nodes = await prisma.node.findMany({
        where: { clusterId: policy.clusterId, state: 'ONLINE', updatesAvailable: { gt: 0 } },
        orderBy: { name: 'asc' },
      });
      for (const node of nodes) {
        const done = await prisma.job.findFirst({
          where: {
            type: JOB_TYPES.nodeUpdate,
            targetIds: { has: node.id },
            // Started by a policy in this opening. A person's attempt does not
            // count: if it worked the node has nothing pending and is not here.
            createdByUserId: null,
            queuedAt: { gte: new Date(state.openedAt) },
          },
          select: { id: true },
        });
        if (done) continue;

        const params: NodeUpdateParams = {
          clusterId: policy.clusterId,
          nodeId: node.id,
          node: node.name,
          rebootPolicy: policy.rebootPolicy,
          requireApproval: policy.requireApproval,
          maintenanceWindowId: policy.maintenanceWindowId,
          policyId: policy.id,
          pending: {
            total: node.updatesAvailable ?? 0,
            security: node.updatesSecurity ?? 0,
            kernel: node.updatesKernel ?? 0,
            proxmox: node.updatesProxmox ?? 0,
          },
        };
        let jobId: string;
        try {
          const job = await prisma.job.create({
            data: {
              tenantId: policy.cluster.tenantId,
              type: JOB_TYPES.nodeUpdate,
              params: params as unknown as Prisma.InputJsonValue,
              concurrencyKey: `cluster:${policy.clusterId}`,
              targetKind: 'node',
              targetIds: [node.id],
              parentJobId: null,
              createdByUserId: null,
            },
            select: { id: true },
          });
          jobId = job.id;
        } catch (error) {
          // Another job took the cluster between the check and the insert.
          if ((error as { code?: unknown } | null)?.code === 'P2002') break;
          throw error;
        }
        await appendJobEvent(prisma, jobId, {
          level: 'INFO',
          key: JOB_EVENT_KEYS.queued,
          message: `Queued by update policy "${policy.name}" in window "${policy.window.name}"`,
          data: { policyId: policy.id, windowId: policy.window.id },
        });
        await prisma.auditEvent.create({
          data: {
            action: 'job.created',
            result: 'SUCCESS',
            actorType: 'SCHEDULER',
            actorLabel: `update policy ${policy.name}`,
            tenantId: policy.cluster.tenantId,
            resourceType: 'job',
            resourceId: jobId,
            resourceLabel: JOB_TYPES.nodeUpdate,
            metadata: { policyId: policy.id, node: node.name, window: policy.window.name },
          },
        });
        await queue.add('run', { jobId }, { jobId: `${jobId}-${Date.now()}` });
        started.push(jobId);
        break; // one node per cluster per tick
      }
    }
    return { started };
  });
}

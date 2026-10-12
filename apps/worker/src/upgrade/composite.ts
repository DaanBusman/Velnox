import type { Queue } from 'bullmq';
import { appendJobEvent, withSystemScope, type Prisma, type VelnoxPrismaClient } from '@velnox/db';
import {
  ACTIVE_JOB_STATUSES,
  JOB_EVENT_KEYS,
  JOB_TYPES,
  compositeNext,
  type UpgradeJobParams,
} from '@velnox/shared';
import type { LibraryServices } from '../library/services';
import { runPlaybookCleanup, writeReport } from './engine';

/**
 * Composite plans, driven in order (Phase 8), every ten seconds.
 *
 * A composite has no job of its own: its children run one after another, each
 * as its own upgrade.run job on the cluster's concurrency key. When the cluster
 * is free and the last child completed, the next starts; when a child failed,
 * the composite fails and the children after it are cancelled, never started;
 * when all completed, the composite is complete. Its report holds theirs.
 *
 * Also, for any plan: a job that ended without its plan hearing of it — one
 * that failed before its first step, or whose worker died — leaves the plan
 * running for ever. Its plan is set to what the job became.
 */

export const UPGRADE_DRIVER_INTERVAL_MS = 10_000;

export async function driveUpgrades(
  prisma: VelnoxPrismaClient,
  queue: Queue,
  services?: LibraryServices,
): Promise<{ started: string[]; finished: string[] }> {
  return withSystemScope('upgrade plans are driven on their own schedule', async () => {
    const started: string[] = [];
    const finished: string[] = [];

    // Plans whose job is over though the plan does not know.
    const running = await prisma.upgradePlan.findMany({
      where: {
        kind: { not: 'COMPOSITE' },
        status: { in: ['RUNNING', 'WAITING_APPROVAL'] },
        jobId: { not: null },
      },
      include: { targets: { orderBy: { sequence: 'asc' } } },
    });
    for (const plan of running) {
      const job = await prisma.job.findUnique({
        where: { id: plan.jobId! },
        select: { status: true },
      });
      if (!job || ACTIVE_JOB_STATUSES.has(job.status)) continue;
      // Its worker's cleanup died with it: undo what must not be left behind.
      if (services && plan.playbookId && job.status !== 'SUCCEEDED') {
        await runPlaybookCleanup(
          services,
          {
            planId: plan.id,
            clusterId: plan.clusterId,
            playbookId: plan.playbookId,
            playbookVersion: plan.playbookVersion ?? 1,
            targets: plan.targets.map((t) => ({ id: t.id, label: t.label })),
          },
          plan.jobId!,
        ).catch(() => undefined);
      }
      await prisma.upgradePlan.update({
        where: { id: plan.id },
        data: {
          status:
            job.status === 'SUCCEEDED'
              ? 'COMPLETED'
              : job.status === 'CANCELLED'
                ? 'CANCELLED'
                : 'FAILED',
          finishedAt: new Date(),
        },
      });
      await writeReport(prisma, plan.id);
    }

    const parents = await prisma.upgradePlan.findMany({
      where: { kind: 'COMPOSITE', status: 'RUNNING' },
      include: {
        children: {
          orderBy: { sequence: 'asc' },
          include: { targets: { orderBy: { sequence: 'asc' } } },
        },
      },
    });
    for (const parent of parents) {
      const next = compositeNext(parent.children.map((c) => ({ id: c.id, status: c.status })));
      if (next.action === 'wait') continue;
      if (next.action === 'done' || next.action === 'stop') {
        if (next.action === 'stop') {
          await prisma.upgradePlan.updateMany({
            where: { parentPlanId: parent.id, status: 'DRAFT' },
            data: { status: 'CANCELLED' },
          });
        }
        await prisma.upgradePlan.update({
          where: { id: parent.id },
          data: { status: next.action === 'done' ? 'COMPLETED' : 'FAILED', finishedAt: new Date() },
        });
        await writeReport(prisma, parent.id);
        finished.push(parent.id);
        continue;
      }

      const child = parent.children.find((c) => c.id === next.childId)!;
      const busy = await prisma.job.findFirst({
        where: {
          concurrencyKey: `cluster:${parent.clusterId}`,
          status: { in: [...ACTIVE_JOB_STATUSES] },
        },
        select: { id: true },
      });
      if (busy) continue;
      const params: UpgradeJobParams = {
        planId: child.id,
        clusterId: child.clusterId,
        playbookId: child.playbookId!,
        playbookVersion: child.playbookVersion ?? 1,
        targets: child.targets.map((t) => ({ id: t.id, label: t.label })),
      };
      let jobId: string;
      try {
        const job = await prisma.job.create({
          data: {
            tenantId: parent.tenantId,
            type: JOB_TYPES.upgradeRun,
            params: params as unknown as Prisma.InputJsonValue,
            concurrencyKey: `cluster:${parent.clusterId}`,
            targetKind: 'cluster',
            targetIds: [parent.clusterId],
            parentJobId: null,
            createdByUserId: parent.createdByUserId,
          },
          select: { id: true },
        });
        jobId = job.id;
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === 'P2002') continue;
        throw error;
      }
      await prisma.upgradePlan.update({
        where: { id: child.id },
        data: { status: 'RUNNING', jobId, startedAt: new Date() },
      });
      if (!parent.startedAt) {
        await prisma.upgradePlan.update({
          where: { id: parent.id },
          data: { startedAt: new Date() },
        });
      }
      await appendJobEvent(prisma, jobId, {
        level: 'INFO',
        key: JOB_EVENT_KEYS.queued,
        message: `Queued by composite plan "${parent.name}": ${child.sequence} of ${parent.children.length}`,
        data: { by: `composite plan "${parent.name}"`, parentPlanId: parent.id },
      });
      await queue.add('run', { jobId }, { jobId: `${jobId}-${Date.now()}` });
      started.push(jobId);
    }
    return { started, finished };
  });
}

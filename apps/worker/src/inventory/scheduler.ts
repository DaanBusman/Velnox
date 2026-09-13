import type { Queue } from 'bullmq';
import { JOB_NAMES } from '@velnox/shared';
import { withSystemScope, type VelnoxPrismaClient } from '@velnox/db';

/**
 * Scheduled discovery.
 *
 * A tick rather than a repeatable job per cluster. BullMQ can schedule per
 * cluster, and that was the first design — it meant every add, every interval
 * change and every removal had to add or remove a repeatable key, and a missed
 * removal leaves a job firing against a cluster that no longer exists. A single
 * repeating tick that reads the current list has none of that: the database is
 * the schedule, and there is nothing to keep in step with it.
 *
 * The tick is cheap. It reads clusters whose interval has elapsed and enqueues
 * one job each; a cluster with an interval of zero is never selected, which is
 * how scheduled discovery is turned off for one customer without turning it off
 * for everyone.
 */

export const SCHEDULER_TICK_JOB = 'inventory.tick';
export const SCHEDULER_TICK_INTERVAL_MS = 60_000;

export interface TickResult {
  considered: number;
  enqueued: number;
}

/**
 * Enqueue discovery for every cluster that is due.
 *
 * "Due" is measured from `lastDiscoveryAt`, not from when the last job was
 * queued. A cluster whose discovery keeps failing is therefore retried at its
 * interval rather than hammered — the timestamp only moves on success.
 */
export async function runSchedulerTick(
  prisma: VelnoxPrismaClient,
  queue: Queue,
  now: Date = new Date(),
): Promise<TickResult> {
  return withSystemScope('scheduled discovery belongs to no request', async () => {
    const clusters = await prisma.cluster.findMany({
      where: { discoveryIntervalMinutes: { gt: 0 } },
      select: { id: true, discoveryIntervalMinutes: true, lastDiscoveryAt: true },
    });

    let enqueued = 0;

    for (const cluster of clusters) {
      if (!isDue(cluster, now)) continue;

      const dueAt = cluster.lastDiscoveryAt
        ? cluster.lastDiscoveryAt.getTime() + cluster.discoveryIntervalMinutes * 60_000
        : now.getTime();

      /*
       * A stable job id per cluster per due-window.
       *
       * BullMQ ignores an `add` whose job id already exists, so a tick that
       * overlaps a run still in flight cannot queue a second one against the
       * same cluster. Without this, a cluster slower than its own interval would
       * accumulate discovery jobs until the queue was nothing else.
       */
      const jobId = `discover:${cluster.id}:${Math.floor(dueAt / 60_000)}`;

      await queue.add(
        JOB_NAMES.inventoryDiscover,
        { clusterId: cluster.id, requestedBy: null },
        { jobId },
      );

      enqueued += 1;
    }

    return { considered: clusters.length, enqueued };
  });
}

/**
 * Whether a cluster is due, as a pure function.
 *
 * Split out so the rule can be tested without a database — it is the only part
 * of the scheduler with an edge, and the edge is "never discovered" meaning
 * "due now" rather than "never due".
 */
export function isDue(
  cluster: { discoveryIntervalMinutes: number; lastDiscoveryAt: Date | null },
  now: Date,
): boolean {
  if (cluster.discoveryIntervalMinutes <= 0) return false;
  if (!cluster.lastDiscoveryAt) return true;
  return (
    cluster.lastDiscoveryAt.getTime() + cluster.discoveryIntervalMinutes * 60_000 <= now.getTime()
  );
}

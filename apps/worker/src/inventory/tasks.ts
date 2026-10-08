import type { VelnoxPrismaClient } from '@velnox/db';
import type { NodeTask, ProxmoxClient } from '@velnox/proxmox';

/** Read again this far back, so a task that ended after the last read is updated. */
const OVERLAP_SECONDS = 2 * 60 * 60;
const DAY_SECONDS = 24 * 60 * 60;

/**
 * Whether Velnox started a task: the task's user is the credential Velnox uses
 * for this cluster. Anything else — a person on the Proxmox interface, a
 * script, a backup schedule — is marked as started outside Velnox.
 *
 * With a password (ticket) credential this cannot tell Velnox from a person
 * signing in to Proxmox with the same account; a dedicated token can.
 */
export function taskOrigin(user: string, principal: string | null): 'VELNOX' | 'OUTSIDE_VELNOX' {
  return principal && user.toLowerCase() === principal.toLowerCase() ? 'VELNOX' : 'OUTSIDE_VELNOX';
}

/**
 * Read each online node's task history since the last read (at most the
 * retention period back) and keep it for the support logs. Part of discovery,
 * and never what makes it fail: a node whose history could not be read is a
 * problem recorded, not a run lost.
 */
export async function collectTasks(
  prisma: VelnoxPrismaClient,
  client: ProxmoxClient,
  cluster: { id: string; tenantId: string; authPrincipal: string | null },
  nodes: string[],
  retentionDays: number,
  now: Date = new Date(),
): Promise<{ stored: number; problems: string[] }> {
  const problems: string[] = [];
  let stored = 0;
  const floor = Math.floor(now.getTime() / 1000) - retentionDays * DAY_SECONDS;

  for (const node of nodes) {
    const last = await prisma.proxmoxTask.findFirst({
      where: { clusterId: cluster.id, node },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true },
    });
    const since = Math.max(
      floor,
      last ? Math.floor(last.startedAt.getTime() / 1000) - OVERLAP_SECONDS : floor,
    );

    let tasks: NodeTask[];
    try {
      tasks = await client.nodeTasks(node, { since });
    } catch (error) {
      problems.push(`${node} tasks: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    for (const task of tasks) {
      if (!task.upid || typeof task.starttime !== 'number') continue;
      const data = {
        tenantId: cluster.tenantId,
        node: task.node ?? node,
        type: task.type ?? 'unknown',
        objectId: task.id ? String(task.id) : null,
        user: task.user ?? 'unknown',
        origin: taskOrigin(task.user ?? '', cluster.authPrincipal),
        status: task.status ?? null,
        startedAt: new Date(task.starttime * 1000),
        endedAt: typeof task.endtime === 'number' ? new Date(task.endtime * 1000) : null,
      };
      await prisma.proxmoxTask.upsert({
        where: { clusterId_upid: { clusterId: cluster.id, upid: task.upid } },
        create: { clusterId: cluster.id, upid: task.upid, ...data },
        update: data,
      });
      stored += 1;
    }
  }
  return { stored, problems };
}

/** Drop tasks older than the support log retention. */
export async function pruneTasks(
  prisma: VelnoxPrismaClient,
  retentionDays: number,
  now: Date = new Date(),
): Promise<number> {
  const before = new Date(now.getTime() - retentionDays * DAY_SECONDS * 1000);
  const result = await prisma.proxmoxTask.deleteMany({ where: { startedAt: { lt: before } } });
  return result.count;
}

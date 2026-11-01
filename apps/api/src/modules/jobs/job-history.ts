import type { Prisma } from '@velnox/db';
import { PERMISSIONS, TERMINAL_JOB_STATUSES, isAllowed } from '@velnox/shared';
import type { Actor } from '../../common/actor';
import type { PrismaService } from '../infrastructure/prisma.service';

const DAY_MS = 24 * 60 * 60_000;

/**
 * Older jobs out of sight (0.7.16).
 *
 * The MSP Super Administrator sets a number of days in Server management; a
 * finished job past it is hidden from everyone without `jobs.history` in its
 * tenant. Unfinished jobs are never hidden, and nothing is deleted. Everything
 * that reads jobs on someone's behalf narrows by this, so a hidden job is not
 * found by id either — it reads as any job outside the reader's reach.
 */
export async function jobsVisibleDays(prisma: PrismaService): Promise<number | null> {
  const settings = await prisma.client.systemSettings.findUnique({
    where: { id: 1 },
    select: { jobsVisibleDays: true },
  });
  return settings?.jobsVisibleDays ?? null;
}

/** The start of the period for this actor, or null when they see every job. */
export async function jobsHiddenBefore(
  prisma: PrismaService,
  actor: Actor,
  now = new Date(),
): Promise<{ since: Date; keep: string[] } | null> {
  if (isAllowed(actor.grants, PERMISSIONS.jobsHistory)) return null;
  const days = await jobsVisibleDays(prisma);
  if (days === null) return null;
  return {
    since: new Date(now.getTime() - days * DAY_MS),
    // Tenants where the actor holds jobs.history after all, through a tenant grant.
    keep: actor.accessibleTenantIds.filter((tenantId) =>
      isAllowed(actor.grants, PERMISSIONS.jobsHistory, { tenantId }),
    ),
  };
}

/** A where clause for the jobs this actor may still see; empty when that is all of them. */
export async function jobsInSight(
  prisma: PrismaService,
  actor: Actor,
  now = new Date(),
): Promise<Prisma.JobWhereInput> {
  const hidden = await jobsHiddenBefore(prisma, actor, now);
  if (!hidden) return {};
  return {
    OR: [
      { status: { notIn: [...TERMINAL_JOB_STATUSES] } },
      { finishedAt: { gte: hidden.since } },
      { finishedAt: null, queuedAt: { gte: hidden.since } },
      ...(hidden.keep.length > 0 ? [{ tenantId: { in: hidden.keep } }] : []),
    ],
  };
}

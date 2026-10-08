import { withSystemScope, type VelnoxPrismaClient } from '@velnox/db';

export interface RetentionResult {
  tenants: number;
  removed: number;
}

const DAY_MS = 24 * 60 * 60_000;

/**
 * Remove audit events older than each tenant's retention.
 *
 * Only tenants with a retention set are touched; the default keeps everything.
 * The removal goes through `velnox_prune_audit_events`, the one path the
 * append-only trigger lets a DELETE through, and which itself refuses anything
 * younger than a year. The MSP organisation's retention also covers the events
 * that belong to no tenant.
 *
 * Every removal is recorded in the same tenant's trail — how many, and before
 * when — so a gap in the log is never unexplained.
 */
export async function pruneAuditEvents(
  prisma: VelnoxPrismaClient,
  now: Date = new Date(),
): Promise<RetentionResult> {
  return withSystemScope('audit retention applies to every tenant', async () => {
    const tenants = await prisma.tenant.findMany({
      where: { auditRetentionDays: { not: null } },
      select: { id: true, name: true, kind: true, auditRetentionDays: true },
    });

    let removed = 0;
    for (const tenant of tenants) {
      const days = tenant.auditRetentionDays!;
      const before = new Date(now.getTime() - days * DAY_MS);
      // The one way old audit events may go is a database function, which the
      // typed client cannot call. Tenant scoping is its first argument — one
      // tenant per call, named from the tenant row just read — and the function
      // itself refuses anything younger than a year.
      // eslint-disable-next-line no-restricted-syntax
      const rows = await prisma.$queryRaw<{ removed: number }[]>`
        SELECT velnox_prune_audit_events(
          ${tenant.id}::uuid, ${tenant.kind === 'MSP_ROOT'}, ${before}::timestamptz
        ) AS removed`;
      const count = Number(rows[0]?.removed ?? 0);
      if (count === 0) continue;
      removed += count;
      await prisma.auditEvent.create({
        data: {
          tenantId: tenant.id,
          actorType: 'SYSTEM',
          actorLabel: 'audit retention',
          action: 'audit.pruned',
          resourceType: 'tenant',
          resourceId: tenant.id,
          resourceLabel: tenant.name,
          result: 'SUCCESS',
          metadata: { removed: count, before: before.toISOString(), retentionDays: days },
        },
      });
    }
    return { tenants: tenants.length, removed };
  });
}

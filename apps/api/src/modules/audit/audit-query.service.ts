import { Injectable } from '@nestjs/common';
import type { AuditResult, Prisma } from '@velnox/db';
import { PrismaService } from '../infrastructure/prisma.service';

/**
 * Reading the audit trail.
 *
 * Separate from `AuditService`, which only writes. Keeping them apart means the
 * thing every request depends on carries no query surface, and the thing with a
 * query surface cannot accidentally be used to write.
 *
 * Paging is by cursor rather than offset: the table only ever grows, and an
 * offset page shifts under the reader as new events arrive — so page two would
 * repeat rows from page one during any period worth reading about.
 */

export interface AuditEventView {
  id: string;
  at: string;
  action: string;
  result: AuditResult;
  actorType: string;
  actorLabel: string | null;
  resourceType: string | null;
  resourceLabel: string | null;
  ip: string | null;
  requestId: string | null;
  metadata: unknown;
}

export interface AuditQuery {
  limit: number;
  /** The `at` timestamp of the last row on the previous page, ISO 8601. */
  cursor?: string;
  action?: string;
  result?: AuditResult;
  tenantId?: string | null;
}

@Injectable()
export class AuditQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: AuditQuery): Promise<{ events: AuditEventView[]; nextCursor: string | null }> {
    const where: Prisma.AuditEventWhereInput = {
      ...(query.action ? { action: { startsWith: query.action } } : {}),
      ...(query.result ? { result: query.result } : {}),
      ...(query.tenantId ? { tenantId: query.tenantId } : {}),
      ...(query.cursor ? { at: { lt: new Date(query.cursor) } } : {}),
    };

    // One more than asked for, so "is there another page" is answered by fact
    // rather than by guessing from a full page.
    const rows = await this.prisma.client.auditEvent.findMany({
      where,
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });

    const page = rows.slice(0, query.limit);
    const hasMore = rows.length > query.limit;

    return {
      events: page.map((row) => ({
        id: row.id,
        at: row.at.toISOString(),
        action: row.action,
        result: row.result,
        actorType: row.actorType,
        actorLabel: row.actorLabel,
        resourceType: row.resourceType,
        resourceLabel: row.resourceLabel,
        ip: row.ip,
        requestId: row.requestId,
        // Already redacted on the way in, so what is stored is what is safe to
        // show. Redacting again here would hide nothing and cost a pass.
        metadata: row.metadata,
      })),
      nextCursor: hasMore ? (page[page.length - 1]?.at.toISOString() ?? null) : null,
    };
  }

  /** Distinct action names present, for a filter that offers only real values. */
  async actions(): Promise<string[]> {
    const rows = await this.prisma.client.auditEvent.findMany({
      distinct: ['action'],
      select: { action: true },
      orderBy: { action: 'asc' },
      take: 200,
    });
    return rows.map((row) => row.action);
  }
}

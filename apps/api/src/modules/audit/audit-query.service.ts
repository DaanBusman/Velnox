import { Injectable } from '@nestjs/common';
import type { AuditEvent, AuditResult, Prisma } from '@velnox/db';
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
  tenantId: string | null;
  tenantName: string | null;
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
  /** The tenants to read; null reads every tenant (MSP staff only). */
  tenantIds?: string[] | null;
  /** Inclusive lower and exclusive upper bound on `at`, ISO 8601. */
  from?: string;
  to?: string;
}

/** The columns of an export, in order. */
const EXPORT_COLUMNS = [
  'at',
  'tenant',
  'action',
  'result',
  'actor_type',
  'actor',
  'resource_type',
  'resource_id',
  'resource',
  'ip',
  'request_id',
  'metadata',
] as const;

/**
 * One CSV cell. Quoted when it must be, and a cell that a spreadsheet would
 * read as a formula (`=`, `+`, `-`, `@`) is prefixed with a quote mark, so an
 * actor label or resource name cannot become a formula in whoever opens the
 * export.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

@Injectable()
export class AuditQueryService {
  constructor(private readonly prisma: PrismaService) {}

  private where(query: Omit<AuditQuery, 'limit' | 'cursor'>): Prisma.AuditEventWhereInput {
    return {
      ...(query.action ? { action: { startsWith: query.action } } : {}),
      ...(query.result ? { result: query.result } : {}),
      ...(query.tenantIds ? { tenantId: { in: query.tenantIds } } : {}),
      ...(query.from || query.to
        ? {
            at: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lt: new Date(query.to) } : {}),
            },
          }
        : {}),
    };
  }

  async list(query: AuditQuery): Promise<{ events: AuditEventView[]; nextCursor: string | null }> {
    const base = this.where(query);
    const where: Prisma.AuditEventWhereInput = query.cursor
      ? { AND: [base, { at: { lt: new Date(query.cursor) } }] }
      : base;

    // One more than asked for, so "is there another page" is answered by fact
    // rather than by guessing from a full page.
    const rows = await this.prisma.client.auditEvent.findMany({
      where,
      include: { tenant: { select: { name: true } } },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });

    const page = rows.slice(0, query.limit);
    const hasMore = rows.length > query.limit;

    return {
      events: page.map((row) => ({
        id: row.id,
        at: row.at.toISOString(),
        tenantId: row.tenantId,
        tenantName: row.tenant?.name ?? null,
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

  /**
   * Every matching event, oldest first, as CSV or JSON Lines, written in
   * batches so an export of years does not sit in memory. Paged by `(at, id)`,
   * not `at` alone: two events in the same millisecond must not be skipped.
   */
  async export(
    query: Omit<AuditQuery, 'limit' | 'cursor'>,
    format: 'csv' | 'json',
    write: (chunk: string) => Promise<void>,
  ): Promise<number> {
    const base = this.where(query);
    let after: { at: Date; id: string } | null = null;
    let count = 0;
    if (format === 'csv') await write(`${EXPORT_COLUMNS.join(',')}\r\n`);
    for (;;) {
      const cursor: Prisma.AuditEventWhereInput | null = after
        ? { OR: [{ at: { gt: after.at } }, { at: after.at, id: { gt: after.id } }] }
        : null;
      const rows: (AuditEvent & { tenant: { name: string } | null })[] =
        await this.prisma.client.auditEvent.findMany({
          where: cursor ? { AND: [base, cursor] } : base,
          include: { tenant: { select: { name: true } } },
          orderBy: [{ at: 'asc' }, { id: 'asc' }],
          take: 1000,
        });
      if (rows.length === 0) break;
      let chunk = '';
      for (const row of rows) {
        const record = {
          at: row.at.toISOString(),
          tenant: row.tenant?.name ?? null,
          action: row.action,
          result: row.result,
          actor_type: row.actorType,
          actor: row.actorLabel,
          resource_type: row.resourceType,
          resource_id: row.resourceId,
          resource: row.resourceLabel,
          ip: row.ip,
          request_id: row.requestId,
          metadata: row.metadata,
        };
        chunk +=
          format === 'csv'
            ? `${EXPORT_COLUMNS.map((column) => csvCell(record[column])).join(',')}\r\n`
            : `${JSON.stringify(record)}\n`;
      }
      await write(chunk);
      count += rows.length;
      const last: AuditEvent = rows[rows.length - 1]!;
      after = { at: last.at, id: last.id };
    }
    return count;
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

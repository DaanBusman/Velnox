import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ERROR_CODES, PERMISSIONS, VelnoxError, isAllowed } from '@velnox/shared';
import { zodQuery } from '../../common/zod-validation.pipe';
import { RequirePermissionSomewhere } from '../../common/auth.guard';
import { AuditQueryService } from './audit-query.service';
import { AuditService, AUDIT_ACTIONS } from './audit.service';

const filterSchema = {
  action: z.string().max(120).optional(),
  result: z.enum(['SUCCESS', 'FAILURE', 'DENIED']).optional(),
  /** Honoured for MSP staff only; anyone else reads their own tenant's trail. */
  tenantId: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
};

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().datetime().optional(),
  ...filterSchema,
});

const exportSchema = z.object({
  format: z.enum(['csv', 'json']).default('csv'),
  ...filterSchema,
});

@ApiTags('audit')
@Controller('audit-events')
export class AuditController {
  constructor(
    private readonly audit: AuditQueryService,
    private readonly writer: AuditService,
  ) {}

  /**
   * Whose trail a request reads. From the principal, never the query string:
   * MSP staff read every tenant's and may narrow it to one; anyone else reads
   * the tenants they hold `audit.read` in — their own, and since Phase 5C the
   * sub-tenants of a main tenant they hold it in — and may narrow to one of
   * those. Asking for any other tenant reads what they may read.
   */
  private scope(request: Request, requested: string | undefined): string[] | null {
    const principal = request.velnoxPrincipal;
    if (!principal) throw new VelnoxError(ERROR_CODES.authSessionExpired, { status: 401 });
    if (principal.isMspRoot) return requested ? [requested] : null;
    const readable = principal.accessibleTenantIds.filter((tenantId) =>
      isAllowed(principal.grants, PERMISSIONS.auditRead, { tenantId }),
    );
    return requested && readable.includes(requested) ? [requested] : readable;
  }

  @RequirePermissionSomewhere(PERMISSIONS.auditRead)
  @Get()
  @ApiOperation({
    summary: 'Read the audit trail',
    description:
      'Newest first, paged by cursor rather than offset — the table only grows, and an offset ' +
      'page shifts under the reader as events arrive. Metadata was redacted on the way in, so ' +
      'what is stored is what is safe to read.',
  })
  async list(
    @Query(zodQuery(listSchema)) query: z.infer<typeof listSchema>,
    @Req() request: Request,
  ) {
    // Scope comes from the principal, never the query string. Reading another
    // tenant's audit trail is precisely what this endpoint must not allow.
    return this.audit.list({
      limit: query.limit,
      ...(query.cursor ? { cursor: query.cursor } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.result ? { result: query.result } : {}),
      ...(query.from ? { from: query.from } : {}),
      ...(query.to ? { to: query.to } : {}),
      tenantIds: this.scope(request, query.tenantId),
    });
  }

  @RequirePermissionSomewhere(PERMISSIONS.auditRead)
  @Get('export')
  @ApiOperation({
    summary: 'Download the audit trail',
    description:
      'Every event matching the filters, oldest first, as CSV or JSON Lines, streamed. The same ' +
      'scope as reading it. The download is itself recorded, with its filters, before it starts.',
  })
  async export(
    @Query(zodQuery(exportSchema)) query: z.infer<typeof exportSchema>,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const tenantIds = this.scope(request, query.tenantId);
    const principal = request.velnoxPrincipal!;
    const filters = {
      ...(query.action ? { action: query.action } : {}),
      ...(query.result ? { result: query.result } : {}),
      ...(query.from ? { from: query.from } : {}),
      ...(query.to ? { to: query.to } : {}),
      tenantIds,
    };

    await this.writer.success(AUDIT_ACTIONS.auditExported, {
      actorType: 'USER',
      actorId: principal.user.id,
      actorLabel: principal.user.email,
      tenantId: principal.user.tenantId,
      resourceType: 'audit_trail',
      // The tenant asked for, as before, and the tenants actually read.
      metadata: { format: query.format, ...filters, tenantId: query.tenantId ?? null },
    });

    const stamp = new Date().toISOString().slice(0, 10);
    response.status(200);
    response.setHeader(
      'content-type',
      query.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
    );
    response.setHeader(
      'content-disposition',
      `attachment; filename="velnox-audit-${stamp}.${query.format === 'csv' ? 'csv' : 'jsonl'}"`,
    );
    response.setHeader('cache-control', 'no-store');

    const write = (chunk: string) =>
      new Promise<void>((resolve, reject) => {
        if (response.write(chunk)) resolve();
        else response.once('drain', resolve).once('error', reject);
      });
    // A byte-order mark, so a spreadsheet opens accented names as UTF-8.
    if (query.format === 'csv') await write('\uFEFF');
    await this.audit.export(filters, query.format, write);
    response.end();
  }

  @RequirePermissionSomewhere(PERMISSIONS.auditRead)
  @Get('actions')
  @ApiOperation({ summary: 'Action names present in the trail, for filtering' })
  async actions() {
    return { actions: await this.audit.actions() };
  }
}

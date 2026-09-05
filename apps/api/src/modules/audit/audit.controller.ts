import { Controller, Get, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { ERROR_CODES, PERMISSIONS, VelnoxError } from '@velnox/shared';
import { zodQuery } from '../../common/zod-validation.pipe';
import { RequirePermission } from '../../common/auth.guard';
import { AuditQueryService } from './audit-query.service';

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().datetime().optional(),
  action: z.string().max(120).optional(),
  result: z.enum(['SUCCESS', 'FAILURE', 'DENIED']).optional(),
});

@ApiTags('audit')
@Controller('audit-events')
export class AuditController {
  constructor(private readonly audit: AuditQueryService) {}

  @RequirePermission(PERMISSIONS.auditRead)
  @Get()
  @ApiOperation({
    summary: 'Read the audit trail',
    description:
      'Newest first, paged by cursor rather than offset — the table only grows, and an offset ' +
      'page shifts under the reader as events arrive. Metadata was redacted on the way in, so ' +
      'what is stored is what is safe to read.',
  })
  async list(@Query(zodQuery(listSchema)) query: z.infer<typeof listSchema>, @Req() request: Request) {
    const principal = request.velnoxPrincipal;
    if (!principal) throw new VelnoxError(ERROR_CODES.authSessionExpired, { status: 401 });

    // Scope comes from the principal, never the query string. Reading another
    // tenant's audit trail is precisely what this endpoint must not allow.
    return this.audit.list({
      limit: query.limit,
      ...(query.cursor ? { cursor: query.cursor } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.result ? { result: query.result } : {}),
      tenantId: principal.isMspRoot ? null : principal.user.tenantId,
    });
  }

  @RequirePermission(PERMISSIONS.auditRead)
  @Get('actions')
  @ApiOperation({ summary: 'Action names present in the trail, for filtering' })
  async actions() {
    return { actions: await this.audit.actions() };
  }
}

import { Body, Controller, Get, Put, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ERROR_CODES, PERMISSIONS, VelnoxError, isAllowed } from '@velnox/shared';
import { RequirePermission, RequirePermissionSomewhere } from '../../common/auth.guard';
import { zodBody, zodQuery } from '../../common/zod-validation.pipe';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { SUPPORT_RETENTION_MAX_DAYS, SupportService } from './support.service';

const exportSchema = z.object({
  /** Honoured for MSP staff, and for others among the tenants they may read. */
  tenantId: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

const settingsSchema = z.object({
  retentionDays: z.number().int().min(1).max(SUPPORT_RETENTION_MAX_DAYS),
});

/**
 * Support logs, beside the audit log (Phase 5C).
 *
 * `support.read` exports them, in the same scope rule as the audit log: MSP
 * staff any tenant, anyone else the tenants they hold it in. `support.manage`
 * sets how long Proxmox tasks are kept — at most thirty days.
 */
@ApiTags('support')
@Controller('support')
export class SupportController {
  constructor(
    private readonly support: SupportService,
    private readonly audit: AuditService,
  ) {}

  private scope(request: Request, requested: string | undefined): string[] | null {
    const principal = request.velnoxPrincipal;
    if (!principal) throw new VelnoxError(ERROR_CODES.authSessionExpired, { status: 401 });
    if (principal.isMspRoot) return requested ? [requested] : null;
    const readable = principal.accessibleTenantIds.filter((tenantId) =>
      isAllowed(principal.grants, PERMISSIONS.supportRead, { tenantId }),
    );
    return requested && readable.includes(requested) ? [requested] : readable;
  }

  @RequirePermissionSomewhere(PERMISSIONS.supportRead)
  @Get('settings')
  @ApiOperation({ summary: 'How long Proxmox tasks are kept for the support logs' })
  async settings() {
    return {
      retentionDays: await this.support.retentionDays(),
      maxDays: SUPPORT_RETENTION_MAX_DAYS,
    };
  }

  @RequirePermission(PERMISSIONS.supportManage)
  @Put('settings')
  @ApiOperation({ summary: 'Shorten (or restore) how long Proxmox tasks are kept, 1–30 days' })
  async update(
    @Body(zodBody(settingsSchema)) body: z.infer<typeof settingsSchema>,
    @Req() request: Request,
  ) {
    const principal = request.velnoxPrincipal!;
    const before = await this.support.retentionDays();
    const retentionDays = await this.support.setRetentionDays(body.retentionDays);
    await this.audit.success(AUDIT_ACTIONS.supportRetentionChanged, {
      actorType: 'USER',
      actorId: principal.user.id,
      actorLabel: principal.user.email,
      tenantId: principal.user.tenantId,
      resourceType: 'support_logs',
      metadata: { from: before, to: retentionDays },
    });
    return { retentionDays, maxDays: SUPPORT_RETENTION_MAX_DAYS };
  }

  @RequirePermissionSomewhere(PERMISSIONS.supportRead)
  @Get('export')
  @ApiOperation({
    summary: 'Download the support logs of a tenant',
    description:
      'JSON Lines: jobs with their steps and output, discovery runs, and the Proxmox tasks of the ' +
      'tenant’s nodes, each marked with whether Velnox started it. The period defaults to how ' +
      'long Proxmox tasks are kept. The download is recorded in the audit log first.',
  })
  async export(
    @Query(zodQuery(exportSchema)) query: z.infer<typeof exportSchema>,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const principal = request.velnoxPrincipal!;
    const tenantIds = this.scope(request, query.tenantId);
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from ? new Date(query.from) : await this.support.defaultFrom(to);

    await this.audit.success(AUDIT_ACTIONS.supportExported, {
      actorType: 'USER',
      actorId: principal.user.id,
      actorLabel: principal.user.email,
      tenantId: principal.user.tenantId,
      resourceType: 'support_logs',
      metadata: {
        tenantId: query.tenantId ?? null,
        tenantIds,
        from: from.toISOString(),
        to: to.toISOString(),
      },
    });

    response.status(200);
    response.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
    response.setHeader(
      'content-disposition',
      `attachment; filename="velnox-support-${to.toISOString().slice(0, 10)}.jsonl"`,
    );
    response.setHeader('cache-control', 'no-store');
    const write = (chunk: string) =>
      new Promise<void>((resolve, reject) => {
        if (response.write(chunk)) resolve();
        else response.once('drain', resolve).once('error', reject);
      });
    await this.support.export({ tenantIds, from, to }, write);
    response.end();
  }
}

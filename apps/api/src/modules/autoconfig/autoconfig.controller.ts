import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import {
  CREDENTIAL_DELIVERIES,
  PDF_PASSWORD_SOURCES,
  PERMISSIONS,
  TEMPLATE_VISIBILITIES,
} from '@velnox/shared';
import { RequirePermissionSomewhere } from '../../common/auth.guard';
import { zodBody, zodQuery } from '../../common/zod-validation.pipe';
import { actorOf } from '../../common/actor';
import { TemplatesService } from './templates.service';

const uuidParam = new ParseUUIDPipe({ version: '4' });

/**
 * A secret's key and its new value. Only keys a template can hold; the service
 * refuses those the settings do not call for.
 */
const secretsSchema = z.record(
  z
    .string()
    .regex(
      /^(account:[a-z_][a-z0-9_-]{0,31}|administrator|root|productKey|pdfPassword|tenant:[0-9a-f-]{36}:(administrator|root))$/i,
    ),
  z.string().min(1).max(200).nullable(),
);

/** The tenants a SELECTED template is offered to. */
const offeredSchema = z.array(z.string().uuid()).max(500);

const templateFields = {
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2000).default(''),
  visibility: z.enum(TEMPLATE_VISIBILITIES).default('SHARED'),
  offeredTenantIds: offeredSchema.default([]),
  credentialDelivery: z.enum(CREDENTIAL_DELIVERIES).default('VELNOX_ONLY'),
  pdfPasswordSource: z.enum(PDF_PASSWORD_SOURCES).default('SHOWN_ONCE'),
  /** Validated by the service against templateSettingsSchema, so the error names the field. */
  settings: z.unknown(),
  secrets: secretsSchema.default({}),
};

const createSchema = z.object({ tenantId: z.string().uuid(), ...templateFields });

const updateSchema = z
  .object({
    name: templateFields.name.optional(),
    description: z.string().trim().max(2000).optional(),
    visibility: z.enum(TEMPLATE_VISIBILITIES).optional(),
    offeredTenantIds: offeredSchema.optional(),
    credentialDelivery: z.enum(CREDENTIAL_DELIVERIES).optional(),
    pdfPasswordSource: z.enum(PDF_PASSWORD_SOURCES).optional(),
    settings: z.unknown().optional(),
    secrets: secretsSchema.optional(),
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: 'Nothing to change',
  });

const cloneSchema = z.object({
  tenantId: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
});

const listQuery = z.object({ offeredTo: z.string().uuid().optional() });

/**
 * Autoconfig templates.
 *
 * `autoconfig.read` to see, `autoconfig.manage` to change — checked in the
 * service against the tenant that owns the template, because the decorator
 * only knows the caller holds it somewhere.
 */
@ApiTags('autoconfig')
@Controller('autoconfig/templates')
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @RequirePermissionSomewhere(PERMISSIONS.autoconfigRead)
  @Get()
  @ApiOperation({
    summary: 'Templates this account may see',
    description:
      'With offeredTo, the templates a VM in that tenant may be built from: its own, the MSP’s shared ones, and — for MSP staff — the MSP’s private ones.',
  })
  list(@Query(zodQuery(listQuery)) query: z.infer<typeof listQuery>, @Req() request: Request) {
    return this.templates.list(actorOf(request), query.offeredTo);
  }

  @RequirePermissionSomewhere(PERMISSIONS.autoconfigRead)
  @Get(':id')
  @ApiOperation({ summary: 'One template. Which secrets are set, never their values.' })
  get(@Param('id', uuidParam) id: string, @Req() request: Request) {
    return this.templates.get(id, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.autoconfigManage)
  @Post()
  @ApiOperation({ summary: 'Create a template in a tenant' })
  create(@Body(zodBody(createSchema)) body: z.infer<typeof createSchema>, @Req() request: Request) {
    return this.templates.create(body, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.autoconfigManage)
  @Patch(':id')
  @ApiOperation({
    summary: 'Change a template',
    description:
      'A secret set to null is removed. Secrets the settings stop calling for are removed too.',
  })
  update(
    @Param('id', uuidParam) id: string,
    @Body(zodBody(updateSchema)) body: z.infer<typeof updateSchema>,
    @Req() request: Request,
  ) {
    return this.templates.update(id, body, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.autoconfigManage)
  @Post(':id/clone')
  @ApiOperation({
    summary: 'Copy a template into a tenant',
    description: 'Settings are copied; stored secrets are not, and the copy lists them as missing.',
  })
  clone(
    @Param('id', uuidParam) id: string,
    @Body(zodBody(cloneSchema)) body: z.infer<typeof cloneSchema>,
    @Req() request: Request,
  ) {
    return this.templates.clone(id, body, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.autoconfigManage)
  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a template. VMs built from it keep their record.' })
  async remove(@Param('id', uuidParam) id: string, @Req() request: Request) {
    await this.templates.remove(id, actorOf(request));
  }
}

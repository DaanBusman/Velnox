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
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { PERMISSIONS } from '@velnox/shared';
import { RequirePermission, RequirePermissionSomewhere } from '../../common/auth.guard';
import { zodBody } from '../../common/zod-validation.pipe';
import { actorOf } from '../../common/actor';
import { TenantsService } from './tenants.service';

const mfaPolicy = z.enum(['OPTIONAL', 'REQUIRED_FOR_PRIVILEGED', 'REQUIRED']);

const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  mfaPolicy: mfaPolicy.optional(),
});

const updateSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
    mfaPolicy: mfaPolicy.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to change' });

const uuidParam = new ParseUUIDPipe({ version: '4' });

/**
 * Tenants.
 *
 * `ARCHIVED` is absent from the update schema deliberately: archiving has
 * preconditions — no active accounts, never the MSP organisation — and routing
 * it through a status field would make it look like any other edit. It has its
 * own verb, so the refusals are attached to the thing that can be refused.
 */
@ApiTags('tenancy')
@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @RequirePermissionSomewhere(PERMISSIONS.tenantsRead)
  @Get()
  @ApiOperation({
    summary: 'List tenants',
    description:
      'Scoped to what the caller may reach: an MSP principal with a global grant sees every ' +
      'tenant, a tenant administrator sees exactly one. The filter is applied in the data layer, ' +
      'not here.',
  })
  async list() {
    return { tenants: await this.tenants.list() };
  }

  @RequirePermissionSomewhere(PERMISSIONS.tenantsRead)
  @Get(':id')
  @ApiOperation({ summary: 'One tenant' })
  get(@Param('id', uuidParam) id: string) {
    return this.tenants.get(id);
  }

  @RequirePermission(PERMISSIONS.tenantsManage)
  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Create a customer tenant',
    description:
      'Requires the permission at global scope. A grant covering one tenant does not let you ' +
      'create another — that is the only write in the product the tenancy filter cannot see, ' +
      'because a new tenant has no tenant to be filtered by.',
  })
  create(@Body(zodBody(createSchema)) body: z.infer<typeof createSchema>, @Req() request: Request) {
    return this.tenants.create(body, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.tenantsManage)
  @Patch(':id')
  @ApiOperation({ summary: 'Rename a tenant, suspend it, or change its MFA policy' })
  update(
    @Param('id', uuidParam) id: string,
    @Body(zodBody(updateSchema)) body: z.infer<typeof updateSchema>,
    @Req() request: Request,
  ) {
    return this.tenants.update(id, body, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.tenantsManage)
  @Delete(':id')
  @ApiOperation({
    summary: 'Archive a tenant',
    description:
      'Nothing is destroyed. The tenant stops appearing and its audit trail stays readable, ' +
      'because "we no longer work with this customer" is not the same as "erase what happened".',
  })
  archive(@Param('id', uuidParam) id: string, @Req() request: Request) {
    return this.tenants.archive(id, actorOf(request));
  }
}

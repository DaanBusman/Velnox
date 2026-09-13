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
import { PERMISSIONS } from '@velnox/shared';
import { RequirePermission, RequirePermissionSomewhere } from '../../common/auth.guard';
import { zodBody, zodQuery } from '../../common/zod-validation.pipe';
import { actorOf } from '../../common/actor';
import { SitesService } from './sites.service';

/** Optional and nullable are different: absent leaves a field alone, null clears it. */
const optionalText = (max: number) => z.string().trim().max(max).nullish();

const createSchema = z.object({
  tenantId: z.string().uuid(),
  name: z.string().trim().min(2).max(120),
  description: optionalText(500),
  locality: optionalText(120),
  // ISO 3166-1 alpha-2. Validated rather than free text so the column stays a
  // country code and not a mix of "NL", "Netherlands" and "nederland".
  country: z.string().trim().length(2).nullish(),
  timezone: optionalText(64),
  contactName: optionalText(120),
  contactEmail: z.string().trim().email().max(320).nullish(),
  contactPhone: optionalText(40),
});

const updateSchema = createSchema
  .omit({ tenantId: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to change' });

const listSchema = z.object({ tenantId: z.string().uuid().optional() });

const uuidParam = new ParseUUIDPipe({ version: '4' });

/**
 * Sites.
 *
 * A site's tenant is fixed at creation and absent from the update schema. Moving
 * one would move every grant scoped to it — and, from Phase 4, every cluster
 * beneath it — into another customer, silently. Deleting and recreating is the
 * honest way to express that, because it forces the grants to be reconsidered.
 */
@ApiTags('tenancy')
@Controller('sites')
export class SitesController {
  constructor(private readonly sites: SitesService) {}

  @RequirePermissionSomewhere(PERMISSIONS.sitesRead)
  @Get()
  @ApiOperation({
    summary: 'List sites',
    description:
      'Optionally narrowed to one tenant. The parameter can only narrow: the data layer has ' +
      'already limited the query to what the caller may reach, so an unreachable id returns an ' +
      'empty list rather than someone else’s sites.',
  })
  async list(@Query(zodQuery(listSchema)) query: z.infer<typeof listSchema>) {
    return { sites: await this.sites.list(query.tenantId) };
  }

  @RequirePermissionSomewhere(PERMISSIONS.sitesRead)
  @Get(':id')
  @ApiOperation({ summary: 'One site' })
  get(@Param('id', uuidParam) id: string) {
    return this.sites.get(id);
  }

  @RequirePermission(PERMISSIONS.sitesManage, (request) => ({
    // The tenant is in the body, so the guard can resolve the scope before the
    // service runs. The service checks it again against the loaded tenant.
    tenantId: (request.body as { tenantId?: string } | undefined)?.tenantId ?? null,
  }))
  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a site' })
  create(@Body(zodBody(createSchema)) body: z.infer<typeof createSchema>, @Req() request: Request) {
    return this.sites.create(body, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.sitesManage)
  @Patch(':id')
  @ApiOperation({ summary: 'Change a site’s details' })
  update(
    @Param('id', uuidParam) id: string,
    @Body(zodBody(updateSchema)) body: z.infer<typeof updateSchema>,
    @Req() request: Request,
  ) {
    return this.sites.update(id, body, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.sitesManage)
  @Delete(':id')
  @ApiOperation({
    summary: 'Remove a site',
    description:
      'Refused while any grant is scoped to it: `scope_id` is polymorphic, so no foreign key ' +
      'would catch the dangling reference and the grants would quietly stop covering anything.',
  })
  remove(@Param('id', uuidParam) id: string, @Req() request: Request) {
    return this.sites.remove(id, actorOf(request));
  }
}

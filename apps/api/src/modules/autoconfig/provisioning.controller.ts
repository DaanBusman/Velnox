import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { PERMISSIONS, provisionRequestSchema } from '@velnox/shared';
import { RequirePermissionSomewhere } from '../../common/auth.guard';
import { zodBody, zodQuery } from '../../common/zod-validation.pipe';
import { actorOf } from '../../common/actor';
import { ProvisioningService } from './provisioning.service';

const uuidParam = new ParseUUIDPipe({ version: '4' });

const provisionListQuery = z.object({ clusterId: z.string().uuid().optional() });

/**
 * Building VMs from templates.
 *
 * Requesting one needs `workloads.provision` on the cluster; revealing its
 * passwords needs `clusters.manage` there, and is audited. Both are checked in
 * the service once the cluster is known.
 */
@ApiTags('provisioning')
@Controller('provisionings')
export class ProvisioningController {
  constructor(private readonly provisioning: ProvisioningService) {}

  @RequirePermissionSomewhere(PERMISSIONS.workloadsRead)
  @Get()
  @ApiOperation({ summary: 'VMs built from templates, newest first' })
  list(@Query(zodQuery(provisionListQuery)) query: z.infer<typeof provisionListQuery>) {
    return this.provisioning.list(query);
  }

  @RequirePermissionSomewhere(PERMISSIONS.workloadsRead)
  @Get(':id')
  @ApiOperation({ summary: 'One VM’s record. Never its passwords.' })
  get(@Param('id', uuidParam) id: string) {
    return this.provisioning.get(id);
  }

  @RequirePermissionSomewhere(PERMISSIONS.workloadsProvision)
  @Post()
  @ApiOperation({
    summary: 'Build a VM from a template',
    description:
      'Returns the record and its job. When the template sends an encrypted record whose password is shown once, the password is in this response and nowhere else.',
  })
  request(
    @Body(zodBody(provisionRequestSchema)) body: z.infer<typeof provisionRequestSchema>,
    @Req() request: Request,
  ) {
    return this.provisioning.request(body, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.clustersManage)
  @Post(':id/reveal')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Show a VM’s passwords',
    description:
      'Audited before the answer is sent, refusals included. The answer carries an expiry after which the page clears it.',
  })
  reveal(@Param('id', uuidParam) id: string, @Req() request: Request) {
    return this.provisioning.reveal(id, actorOf(request));
  }
}

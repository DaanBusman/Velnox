import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import {
  PERMISSIONS,
  maintenanceWindowSchema,
  nodeUpdateRequestSchema,
  updatePolicySchema,
} from '@velnox/shared';
import { RequirePermissionSomewhere } from '../../common/auth.guard';
import { zodBody, zodQuery } from '../../common/zod-validation.pipe';
import { actorOf } from '../../common/actor';
import { UpdatesService } from './updates.service';

const uuidParam = new ParseUUIDPipe({ version: '4' });
const nodesQuery = z.object({ clusterId: z.string().uuid().optional() });
const windowBody = maintenanceWindowSchema.extend({ tenantId: z.string().uuid() });

/**
 * Update management (Phase 6). The decorators say the caller holds the
 * permission somewhere; the service checks it at the node's, window's or
 * policy's tenant and cluster.
 */
@ApiTags('updates')
@Controller('updates')
export class UpdatesController {
  constructor(private readonly updates: UpdatesService) {}

  @RequirePermissionSomewhere(PERMISSIONS.updatesRead)
  @Get('nodes')
  @ApiOperation({
    summary: 'Pending updates per node, classified, and whether each needs a reboot',
  })
  nodes(@Query(zodQuery(nodesQuery)) query: z.infer<typeof nodesQuery>) {
    return this.updates.nodes(query);
  }

  @RequirePermissionSomewhere(PERMISSIONS.updatesRead)
  @Get('nodes/:id/packages')
  @ApiOperation({ summary: 'The packages one node would update' })
  packages(@Param('id', uuidParam) id: string) {
    return this.updates.packages(id);
  }

  @RequirePermissionSomewhere(PERMISSIONS.updatesExecute)
  @Post('nodes/:id/run')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Update a node now',
    description:
      'Starts a node.update job. Needs SSH on the cluster with the node’s host key confirmed. Under ' +
      'a policy, its approval, reboot policy and maintenance window apply; outside the window this ' +
      'is refused with when it next opens.',
  })
  run(
    @Param('id', uuidParam) id: string,
    @Body(zodBody(nodeUpdateRequestSchema)) body: z.infer<typeof nodeUpdateRequestSchema>,
    @Req() request: Request,
  ) {
    return this.updates.run(id, body, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.updatesRead)
  @Get('windows')
  @ApiOperation({
    summary: 'Maintenance windows, with whether each is open and when it next opens',
  })
  windows() {
    return this.updates.windows();
  }

  @RequirePermissionSomewhere(PERMISSIONS.updatesManage)
  @Post('windows')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a maintenance window for a tenant' })
  createWindow(
    @Body(zodBody(windowBody)) body: z.infer<typeof windowBody>,
    @Req() request: Request,
  ) {
    return this.updates.saveWindow(null, body, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.updatesManage)
  @Put('windows/:id')
  @ApiOperation({ summary: 'Change a maintenance window' })
  changeWindow(
    @Param('id', uuidParam) id: string,
    @Body(zodBody(windowBody)) body: z.infer<typeof windowBody>,
    @Req() request: Request,
  ) {
    return this.updates.saveWindow(id, body, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.updatesManage)
  @Delete('windows/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a maintenance window no policy uses' })
  async deleteWindow(@Param('id', uuidParam) id: string, @Req() request: Request) {
    await this.updates.deleteWindow(id, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.updatesRead)
  @Get('policies')
  @ApiOperation({ summary: 'Update policies, one per cluster at most' })
  policies() {
    return this.updates.policies();
  }

  @RequirePermissionSomewhere(PERMISSIONS.updatesManage)
  @Put('policies')
  @ApiOperation({ summary: 'Set a cluster’s update policy, replacing the one it had' })
  savePolicy(
    @Body(zodBody(updatePolicySchema)) body: z.infer<typeof updatePolicySchema>,
    @Req() request: Request,
  ) {
    return this.updates.savePolicy(body, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.updatesManage)
  @Delete('policies/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a cluster’s update policy' })
  async deletePolicy(@Param('id', uuidParam) id: string, @Req() request: Request) {
    await this.updates.deletePolicy(id, actorOf(request));
  }
}

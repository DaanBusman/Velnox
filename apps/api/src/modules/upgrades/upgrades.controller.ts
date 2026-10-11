import {
  Body,
  Controller,
  Delete,
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
import { PERMISSIONS, createUpgradePlanSchema } from '@velnox/shared';
import { RequirePermissionSomewhere } from '../../common/auth.guard';
import { zodBody, zodQuery } from '../../common/zod-validation.pipe';
import { actorOf } from '../../common/actor';
import { UpgradesService } from './upgrades.service';

const uuidParam = new ParseUUIDPipe({ version: '4' });
const listQuery = z.object({ clusterId: z.string().uuid().optional() });

/**
 * Major upgrade plans (Phase 8). The decorators say the caller holds the
 * permission somewhere; the service checks it at the plan's cluster.
 */
@ApiTags('upgrades')
@Controller('upgrades')
export class UpgradesController {
  constructor(private readonly upgrades: UpgradesService) {}

  @RequirePermissionSomewhere(PERMISSIONS.upgradesRead)
  @Get('playbooks')
  @ApiOperation({ summary: 'The upgrade playbooks this caller may plan with' })
  playbooks(@Req() request: Request) {
    return { playbooks: this.upgrades.playbooks(actorOf(request)) };
  }

  @RequirePermissionSomewhere(PERMISSIONS.upgradesRead)
  @Get('plans')
  @ApiOperation({
    summary: 'Upgrade plans, newest first; a composite’s children are in its detail',
  })
  async list(@Query(zodQuery(listQuery)) query: z.infer<typeof listQuery>) {
    return { plans: await this.upgrades.list(query) };
  }

  @RequirePermissionSomewhere(PERMISSIONS.upgradesExecute)
  @Post('plans')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Plan an upgrade, or a composite of several run in order',
    description:
      'Targets come from the inventory: nodes by name, Ceph daemons in Ceph’s upgrade order.',
  })
  create(
    @Body(zodBody(createUpgradePlanSchema)) body: z.infer<typeof createUpgradePlanSchema>,
    @Req() request: Request,
  ) {
    return this.upgrades.create(body, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.upgradesRead)
  @Get('plans/:id')
  @ApiOperation({
    summary: 'A plan: its targets, every run of its checks, its remediations, its children',
  })
  detail(@Param('id', uuidParam) id: string) {
    return this.upgrades.detail(id);
  }

  @RequirePermissionSomewhere(PERMISSIONS.upgradesExecute)
  @Post('plans/:id/run')
  @HttpCode(201)
  @ApiOperation({ summary: 'Start a plan that has not run yet' })
  run(@Param('id', uuidParam) id: string, @Req() request: Request) {
    return this.upgrades.run(id, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.upgradesExecute)
  @Delete('plans/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a plan that has not run yet' })
  async remove(@Param('id', uuidParam) id: string, @Req() request: Request) {
    await this.upgrades.remove(id, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.upgradesRead)
  @Get('plans/:id/report')
  @ApiOperation({ summary: 'A plan’s report, structured and as Markdown' })
  report(@Param('id', uuidParam) id: string) {
    return this.upgrades.report(id);
  }
}

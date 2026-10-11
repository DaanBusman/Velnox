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
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { z } from 'zod';
import { PERMISSIONS, placementRuleSchema, placementSettingsSchema } from '@velnox/shared';
import { RequirePermissionSomewhere } from '../../common/auth.guard';
import { zodBody } from '../../common/zod-validation.pipe';
import { actorOf } from '../../common/actor';
import { PlacementService } from './placement.service';

const uuidParam = new ParseUUIDPipe({ version: '4' });

/**
 * Placement (Phase 7B). The decorators say the caller holds the permission
 * somewhere; the service checks it at the cluster.
 */
@ApiTags('placement')
@Controller('placement')
export class PlacementController {
  constructor(private readonly placement: PlacementService) {}

  @RequirePermissionSomewhere(PERMISSIONS.placementRead)
  @Get('clusters/:id')
  @ApiOperation({
    summary: 'A cluster’s placement rules, whether each holds, and its placement settings',
    description:
      'Whether a rule holds is read from the inventory. On PVE 9 each rule says whether ' +
      'Proxmox’s HA rules hold it as Velnox wrote it.',
  })
  view(@Param('id', uuidParam) id: string, @Req() request: Request) {
    return this.placement.view(id, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.placementManage)
  @Post('clusters/:id/rules')
  @HttpCode(201)
  @ApiOperation({ summary: 'Add a placement rule: keep apart, keep together, or prefer nodes' })
  createRule(
    @Param('id', uuidParam) id: string,
    @Body(zodBody(placementRuleSchema)) body: z.infer<typeof placementRuleSchema>,
    @Req() request: Request,
  ) {
    return this.placement.createRule(id, body, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.placementManage)
  @Put('rules/:id')
  @ApiOperation({ summary: 'Change a placement rule' })
  updateRule(
    @Param('id', uuidParam) id: string,
    @Body(zodBody(placementRuleSchema)) body: z.infer<typeof placementRuleSchema>,
    @Req() request: Request,
  ) {
    return this.placement.updateRule(id, body, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.placementManage)
  @Delete('rules/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a placement rule, from Proxmox’s HA rules too on PVE 9' })
  async deleteRule(@Param('id', uuidParam) id: string, @Req() request: Request) {
    await this.placement.deleteRule(id, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.placementManage)
  @Put('clusters/:id/settings')
  @ApiOperation({
    summary: 'Whether Velnox corrects placement by itself, and balances memory',
  })
  saveSettings(
    @Param('id', uuidParam) id: string,
    @Body(zodBody(placementSettingsSchema)) body: z.infer<typeof placementSettingsSchema>,
    @Req() request: Request,
  ) {
    return this.placement.saveSettings(id, body, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.placementManage)
  @Post('clusters/:id/correct')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Move guests now to meet the placement rules',
    description: 'Starts a cluster.placement job. Refused while the cluster is not whole.',
  })
  correct(@Param('id', uuidParam) id: string, @Req() request: Request) {
    return this.placement.start(id, 'correct', actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.placementManage)
  @Post('clusters/:id/balance')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Move one guest now to even out memory use, within the rules',
    description: 'Starts a cluster.placement job. Refused while the cluster is not whole.',
  })
  balance(@Param('id', uuidParam) id: string, @Req() request: Request) {
    return this.placement.start(id, 'balance', actorOf(request));
  }
}

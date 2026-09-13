import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { PERMISSIONS } from '@velnox/shared';
import { RequirePermissionSomewhere } from '../../common/auth.guard';
import { zodQuery } from '../../common/zod-validation.pipe';
import { InventoryReadService } from './inventory-read.service';
import { AlertsService } from './alerts.service';

const filterSchema = z.object({
  clusterId: z.string().uuid().optional(),
  nodeId: z.string().uuid().optional(),
});

/**
 * The cross-cluster views: storage, networks and alerts.
 *
 * Each of these is a fleet-wide question — "where is the disk", "what is on
 * vmbr0", "what needs looking at" — which is why they are flat lists across
 * every cluster the caller can reach rather than something you have to open a
 * cluster to find.
 */
@ApiTags('inventory')
@Controller()
export class ResourcesController {
  constructor(
    private readonly inventory: InventoryReadService,
    private readonly alerts: AlertsService,
  ) {}

  @RequirePermissionSomewhere(PERMISSIONS.storageRead)
  @Get('storage')
  @ApiOperation({ summary: 'Every storage on every node' })
  async storage(@Query(zodQuery(filterSchema)) query: z.infer<typeof filterSchema>) {
    return { storages: await this.inventory.listStorages(query) };
  }

  @RequirePermissionSomewhere(PERMISSIONS.networksRead)
  @Get('networks')
  @ApiOperation({ summary: 'Every network interface on every node' })
  async networks(@Query(zodQuery(filterSchema)) query: z.infer<typeof filterSchema>) {
    return { interfaces: await this.inventory.listInterfaces(query) };
  }

  @RequirePermissionSomewhere(PERMISSIONS.alertsRead)
  @Get('alerts')
  @ApiOperation({
    summary: 'What needs looking at',
    description:
      'Derived from the inventory on every request rather than stored, so an alert disappears ' +
      'the moment its condition does and can never be stale. There is no acknowledgement and no ' +
      'notification yet — see docs/known-gaps.md.',
  })
  async list() {
    return { alerts: await this.alerts.list() };
  }
}

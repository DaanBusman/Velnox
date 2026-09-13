import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { PERMISSIONS } from '@velnox/shared';
import { RequirePermissionSomewhere } from '../../common/auth.guard';
import { zodQuery } from '../../common/zod-validation.pipe';
import { InventoryReadService } from './inventory-read.service';

const workloadListSchema = z.object({
  clusterId: z.string().uuid().optional(),
  nodeId: z.string().uuid().optional(),
  kind: z.enum(['QEMU', 'LXC']).optional(),
});

/**
 * Guests.
 *
 * One table underneath, discriminated by kind — they share almost every column
 * and every consumer treats them the same way. The brief asks for virtual
 * machines and containers as separate resources, so they are separate routes
 * over the same query, which keeps the external contract without duplicating it
 * in the database (docs/database-schema.md records the deviation).
 */
@ApiTags('inventory')
@Controller()
export class WorkloadsController {
  constructor(private readonly inventory: InventoryReadService) {}

  @RequirePermissionSomewhere(PERMISSIONS.workloadsRead)
  @Get('workloads')
  @ApiOperation({ summary: 'List virtual machines and containers' })
  async list(@Query(zodQuery(workloadListSchema)) query: z.infer<typeof workloadListSchema>) {
    return { workloads: await this.inventory.listWorkloads(query) };
  }

  @RequirePermissionSomewhere(PERMISSIONS.workloadsRead)
  @Get('virtual-machines')
  @ApiOperation({ summary: 'List virtual machines' })
  async virtualMachines(
    @Query(zodQuery(workloadListSchema)) query: z.infer<typeof workloadListSchema>,
  ) {
    return { workloads: await this.inventory.listWorkloads({ ...query, kind: 'QEMU' }) };
  }

  @RequirePermissionSomewhere(PERMISSIONS.workloadsRead)
  @Get('containers')
  @ApiOperation({ summary: 'List containers' })
  async containers(@Query(zodQuery(workloadListSchema)) query: z.infer<typeof workloadListSchema>) {
    return { workloads: await this.inventory.listWorkloads({ ...query, kind: 'LXC' }) };
  }
}

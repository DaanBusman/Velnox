import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { PERMISSIONS } from '@velnox/shared';
import { RequirePermissionSomewhere } from '../../common/auth.guard';
import { zodQuery } from '../../common/zod-validation.pipe';
import { InventoryReadService } from './inventory-read.service';

const uuidParam = new ParseUUIDPipe({ version: '4' });

const nodeListSchema = z.object({
  clusterId: z.string().uuid().optional(),
  tenantId: z.string().uuid().optional(),
});

@ApiTags('inventory')
@Controller('nodes')
export class NodesController {
  constructor(private readonly inventory: InventoryReadService) {}

  @RequirePermissionSomewhere(PERMISSIONS.nodesRead)
  @Get()
  @ApiOperation({ summary: 'List nodes' })
  async list(@Query(zodQuery(nodeListSchema)) query: z.infer<typeof nodeListSchema>) {
    return { nodes: await this.inventory.listNodes(query) };
  }

  @RequirePermissionSomewhere(PERMISSIONS.nodesRead)
  @Get(':id')
  @ApiOperation({
    summary: 'One node, with its storage, network, guests and Ceph daemons',
  })
  get(@Param('id', uuidParam) id: string) {
    return this.inventory.getNode(id);
  }
}

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ClustersController } from './clusters.controller';
import { NodesController } from './nodes.controller';
import { WorkloadsController } from './workloads.controller';
import { ClustersService } from './clusters.service';
import { InventoryReadService } from './inventory-read.service';

/**
 * Proxmox inventory.
 *
 * Imports AuthModule for the secret store: adding a cluster writes an encrypted
 * credential. It cannot read one back — `SecretStoreService.get` refuses every
 * infrastructure kind, and only the worker holds a store that does not.
 */
@Module({
  imports: [AuthModule],
  controllers: [ClustersController, NodesController, WorkloadsController],
  providers: [ClustersService, InventoryReadService],
  exports: [ClustersService, InventoryReadService],
})
export class InventoryModule {}

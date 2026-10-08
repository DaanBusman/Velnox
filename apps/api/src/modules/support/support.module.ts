import { Module } from '@nestjs/common';
import { SupportController } from './support.controller';
import { SupportService } from './support.service';

/** Support logs: export per tenant, and how long Proxmox tasks are kept (Phase 5C). */
@Module({
  controllers: [SupportController],
  providers: [SupportService],
})
export class SupportModule {}

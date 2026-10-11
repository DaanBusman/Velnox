import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module';
import { UpgradesController } from './upgrades.controller';
import { UpgradesService } from './upgrades.service';

/** Major upgrade plans (Phase 8): playbooks, plans and their targets, running them, reports. */
@Module({
  imports: [JobsModule],
  controllers: [UpgradesController],
  providers: [UpgradesService],
})
export class UpgradesModule {}

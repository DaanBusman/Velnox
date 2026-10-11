import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module';
import { PlacementController } from './placement.controller';
import { PlacementService } from './placement.service';

/** Placement (Phase 7B): rules, whether they hold, settings, corrections and balancing. */
@Module({
  imports: [JobsModule],
  controllers: [PlacementController],
  providers: [PlacementService],
})
export class PlacementModule {}

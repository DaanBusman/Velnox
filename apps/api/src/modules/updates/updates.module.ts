import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module';
import { UpdatesController } from './updates.controller';
import { UpdatesService } from './updates.service';

/** Update management (Phase 6): pending updates, windows, policies, and running one. */
@Module({
  imports: [JobsModule],
  controllers: [UpdatesController],
  providers: [UpdatesService],
})
export class UpdatesModule {}

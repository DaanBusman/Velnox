import { Module } from '@nestjs/common';
import { JobStreamHub } from './job-stream.hub';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';

/** Audit, Prisma, Redis and the queue producer come from global modules. */
@Module({
  controllers: [JobsController],
  providers: [JobsService, JobStreamHub],
})
export class JobsModule {}

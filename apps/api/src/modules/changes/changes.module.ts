import { Module } from '@nestjs/common';
import { ChangeHub } from './change.hub';
import { ChangesController } from './changes.controller';
import { ChangesService } from './changes.service';

/** Prisma and Redis come from global modules. */
@Module({
  controllers: [ChangesController],
  providers: [ChangesService, ChangeHub],
})
export class ChangesModule {}

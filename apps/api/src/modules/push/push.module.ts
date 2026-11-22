import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PushController } from './push.controller';
import { PushService } from './push.service';

/** Approval notifications. The worker sends; this keeps who wants them. */
@Module({
  imports: [AuthModule],
  controllers: [PushController],
  providers: [PushService],
})
export class PushModule {}

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MailController } from './mail.controller';
import { MailService } from './mail.service';

/** Outgoing mail settings. The worker sends; this stores and asks it to test. */
@Module({
  imports: [AuthModule],
  controllers: [MailController],
  providers: [MailService],
})
export class MailModule {}

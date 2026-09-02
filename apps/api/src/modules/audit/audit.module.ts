import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';

/** Global: every module records events, and threading it through imports adds
 *  noise without adding a boundary that means anything. */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}

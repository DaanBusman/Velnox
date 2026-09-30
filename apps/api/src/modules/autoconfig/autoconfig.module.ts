import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { JobsModule } from '../jobs/jobs.module';
import { TemplatesController } from './autoconfig.controller';
import { ProvisioningController } from './provisioning.controller';
import { ProvisioningService } from './provisioning.service';
import { TemplatesService } from './templates.service';

/** Autoconfig templates, and the VMs built from them. */
@Module({
  // AuthModule for the secret store: a template's secrets and a record's password are written here.
  imports: [AuthModule, JobsModule],
  controllers: [TemplatesController, ProvisioningController],
  providers: [TemplatesService, ProvisioningService],
})
export class AutoconfigModule {}

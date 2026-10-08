import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { HealthModule } from '../health/health.module';
import { CaddyAdminService } from './caddy-admin.service';
import { SystemController } from './system.controller';
import { SystemService } from './system.service';
import { TlsConfigService } from './tls-config.service';
import { TlsService } from './tls.service';
import { MetricsController } from './metrics.controller';

@Module({
  // AuthModule for the secret store: an uploaded certificate's key is kept there.
  imports: [HealthModule, AuthModule],
  controllers: [SystemController, MetricsController],
  providers: [SystemService, TlsService, CaddyAdminService, TlsConfigService],
})
export class SystemModule {}

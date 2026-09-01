import { Module } from '@nestjs/common';
import { HealthModule } from '../health/health.module';
import { SystemController } from './system.controller';
import { SystemService } from './system.service';
import { MetricsController } from './metrics.controller';

@Module({
  imports: [HealthModule],
  controllers: [SystemController, MetricsController],
  providers: [SystemService],
})
export class SystemModule {}

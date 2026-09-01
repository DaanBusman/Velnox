import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { InfrastructureModule } from './modules/infrastructure/infrastructure.module';
import { HealthModule } from './modules/health/health.module';
import { SystemModule } from './modules/system/system.module';

/**
 * Application composition root.
 *
 * Feature modules are added here as each phase lands. What is deliberately
 * absent is any module that reaches a managed node: SSH, Proxmox and WinRM
 * adapters exist only in the worker image (docs/tech-decisions.md ADR-009).
 */
@Module({
  imports: [ConfigModule, InfrastructureModule, HealthModule, SystemModule],
})
export class AppModule {}

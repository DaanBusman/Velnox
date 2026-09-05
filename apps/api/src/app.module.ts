import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from './config/config.module';
import { LoggerModule } from './common/logger.module';
import { AuthGuard } from './common/auth.guard';
import { InfrastructureModule } from './modules/infrastructure/infrastructure.module';
import { HealthModule } from './modules/health/health.module';
import { SystemModule } from './modules/system/system.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { SetupModule } from './modules/setup/setup.module';
import { IdentityModule } from './modules/identity/identity.module';
import { RolesModule } from './modules/roles/roles.module';
import { UsersModule } from './modules/users/users.module';

/**
 * Application composition root.
 *
 * AuthGuard is registered globally rather than per controller: a new endpoint is
 * then protected by default and must opt out with @Public(). The alternative
 * fails silently exactly once, and the failure is an open endpoint.
 *
 * Still deliberately absent is any module that reaches a managed node — SSH,
 * Proxmox and WinRM adapters exist only in the worker image (ADR-009).
 */
@Module({
  imports: [
    ConfigModule,
    LoggerModule,
    InfrastructureModule,
    AuditModule,
    AuthModule,
    SetupModule,
    UsersModule,
    IdentityModule,
    RolesModule,
    HealthModule,
    SystemModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}

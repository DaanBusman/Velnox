import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';
import { SitesController } from './sites.controller';
import { SitesService } from './sites.service';

/**
 * Tenants and sites.
 *
 * One module for both, because a site is meaningless without the tenant it
 * belongs to and every question about one reaches the other.
 */
@Module({
  imports: [AuthModule],
  controllers: [TenantsController, SitesController],
  providers: [TenantsService, SitesService],
  exports: [TenantsService, SitesService],
})
export class TenancyModule {}

import { Inject, Injectable } from '@nestjs/common';
import { UPSTREAM_SOURCE_URL, type ApiConfig } from '@velnox/config';
import { ensureSystemSettings } from '@velnox/db';
import { LOCALES, type Locale, type SourceOfferResponse, type SystemInfoResponse } from '@velnox/shared';
import { API_CONFIG } from '../../config/config.module';
import { PrismaService } from '../infrastructure/prisma.service';

@Injectable()
export class SystemService {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly prisma: PrismaService,
  ) {}

  async info(): Promise<SystemInfoResponse> {
    const settings = await ensureSystemSettings(this.prisma.client);

    return {
      product: settings.productName,
      version: this.config.VELNOX_VERSION,
      environment: this.config.NODE_ENV,
      defaultLocale: (settings.defaultLocale as Locale) ?? this.config.VELNOX_DEFAULT_LOCALE,
      supportedLocales: LOCALES,
      defaultTimezone: settings.defaultTimezone,
      initialized: settings.initialized,
      features: {
        // Phase 2 onwards. Reported so the frontend never guesses at what exists.
        authentication: true,
        microsoftSso: false,
        multiTenancy: false,
        proxmoxInventory: false,
        jobs: false,
        metrics: this.config.METRICS_ENABLED,
      },
    };
  }

  /**
   * AGPL section 13 source offer.
   *
   * The settings row may override the build-time URL, which is what an operator
   * running a modified build sets. `modified` is derived rather than declared:
   * if the effective URL is not the upstream one, this build is presenting
   * itself as modified, and the UI says so.
   */
  async source(): Promise<SourceOfferResponse> {
    const settings = await ensureSystemSettings(this.prisma.client);
    const url = settings.sourceUrl?.trim() || this.config.VELNOX_SOURCE_URL;

    return {
      product: settings.productName,
      version: this.config.VELNOX_VERSION,
      commit: this.config.VELNOX_BUILD_COMMIT,
      // An unset build time arrives as an empty string from compose, not as
      // undefined. The contract says string | null, so normalise it.
      builtAt: this.config.VELNOX_BUILD_TIME?.trim() || null,
      license: 'AGPL-3.0-or-later',
      url,
      modified: url !== UPSTREAM_SOURCE_URL,
      notice:
        'Velnox is free software under the GNU Affero General Public License v3 or later. ' +
        'Section 13 requires that users interacting with a modified version over a network be ' +
        'offered its Corresponding Source. The link above serves that offer for the build ' +
        'identified by the commit shown.',
    };
  }

}

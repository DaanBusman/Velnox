import { Inject, Injectable } from '@nestjs/common';
import { UPSTREAM_SOURCE_URL, type ApiConfig } from '@velnox/config';
import { ensureSystemSettings } from '@velnox/db';
import {
  ERROR_CODES,
  LOCALES,
  VelnoxError,
  type Locale,
  type PingJobAcceptedResponse,
  type PingJobStatusResponse,
  type SourceOfferResponse,
  type SystemInfoResponse,
} from '@velnox/shared';
import { API_CONFIG } from '../../config/config.module';
import { PrismaService } from '../infrastructure/prisma.service';
import { QueueService } from '../infrastructure/queue.service';

@Injectable()
export class SystemService {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
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
        authentication: false,
        microsoftSso: false,
        multiTenancy: false,
        proxmoxInventory: false,
        jobs: false,
        devEndpoints: this.config.VELNOX_DEV_ENDPOINTS,
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

  private assertDevEndpointsEnabled(): void {
    if (!this.config.VELNOX_DEV_ENDPOINTS) {
      throw new VelnoxError(ERROR_CODES.featureDisabled, {
        status: 404,
        message: 'Diagnostic endpoints are disabled. Set VELNOX_DEV_ENDPOINTS=true to enable them.',
      });
    }
  }

  /**
   * Phase 1 queue self-test: enqueue a job and let the caller watch the worker
   * pick it up. This is the demonstration that the api -> Redis -> worker path
   * actually works, rather than a claim that it does. Phase 5 replaces it with
   * the real job system, and this endpoint is removed with the dev flag.
   */
  async startQueueSelfTest(): Promise<PingJobAcceptedResponse> {
    this.assertDevEndpointsEnabled();
    const queuedAt = new Date().toISOString();
    const jobId = await this.queue.enqueuePing({ requestedAt: queuedAt });
    return { jobId, queuedAt };
  }

  async queueSelfTestStatus(jobId: string): Promise<PingJobStatusResponse> {
    this.assertDevEndpointsEnabled();

    const job = await this.queue.describeJob(jobId);
    if (!job) {
      throw new VelnoxError(ERROR_CODES.jobNotFound, {
        status: 404,
        message: `No queued job with id ${jobId}`,
        params: { jobId },
      });
    }

    const iso = (value: number | null): string | null =>
      value === null ? null : new Date(value).toISOString();

    const result =
      job.returnValue && typeof job.returnValue === 'object'
        ? (job.returnValue as PingJobStatusResponse['result'])
        : null;

    return {
      jobId,
      state: normaliseState(job.state),
      queuedAt: iso(job.queuedAt),
      startedAt: iso(job.startedAt),
      finishedAt: iso(job.finishedAt),
      attempts: job.attempts,
      result,
      failedReason: job.failedReason,
    };
  }
}

function normaliseState(state: string): PingJobStatusResponse['state'] {
  switch (state) {
    case 'waiting':
    case 'active':
    case 'completed':
    case 'failed':
    case 'delayed':
    case 'paused':
      return state;
    default:
      return 'unknown';
  }
}

import { Inject, Injectable } from '@nestjs/common';
import type { ApiConfig } from '@velnox/config';
import { withSystemScope } from '@velnox/db';
import {
  ERROR_CODES,
  JOB_NAMES,
  UPDATE_CHECK_ERRORS,
  VelnoxError,
  advisoriesFor,
  compareReleaseVersions,
  releaseManifestSchema,
  type UpdateCheckError,
  type UpdateStatusResponse,
} from '@velnox/shared';
import { API_CONFIG } from '../../config/config.module';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { PrismaService } from '../infrastructure/prisma.service';
import { QueueService } from '../infrastructure/queue.service';
import type { Actor } from '../../common/actor';

/** How long Check now waits for the worker: its read gives up after twenty seconds. */
const CHECK_TIMEOUT_MS = 30_000;

/**
 * Is there a newer Velnox (0.7.21).
 *
 * The worker reads the release file and writes down what it found; this reads
 * that back and works out, against the version actually running, whether it is
 * newer and which advisories concern this installation. Switching the check
 * off and Check now are Server management's, with system.manage.
 */
@Injectable()
export class UpdateCheckService {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
  ) {}

  async status(): Promise<UpdateStatusResponse> {
    const row = await withSystemScope('the update check is installation-wide', () =>
      this.prisma.client.systemSettings.findUnique({
        where: { id: 1 },
        select: {
          updateCheckEnabled: true,
          updateManifest: true,
          updateCheckedAt: true,
          updateSucceededAt: true,
          updateCheckError: true,
          updateCheckErrorDetail: true,
        },
      }),
    );
    const running = this.config.VELNOX_VERSION;
    // What is stored was valid when it was read; it is read again here so a
    // row written by an older worker cannot reach the interface unchecked.
    const parsed = releaseManifestSchema.safeParse(row?.updateManifest ?? null);
    const manifest = parsed.success ? parsed.data : null;
    const enabled = row?.updateCheckEnabled ?? true;
    const updateAvailable = Boolean(enabled && manifest && compareReleaseVersions(manifest.version, running) > 0);
    const advisories = updateAvailable && manifest ? advisoriesFor(manifest, running) : [];
    const error = (UPDATE_CHECK_ERRORS as readonly string[]).includes(row?.updateCheckError ?? '')
      ? (row!.updateCheckError as UpdateCheckError)
      : null;

    return {
      enabled,
      running,
      latest: manifest?.version ?? null,
      updateAvailable,
      critical: advisories.some((advisory) => advisory.severity === 'critical'),
      advisories,
      checkedAt: row?.updateCheckedAt?.toISOString() ?? null,
      succeededAt: row?.updateSucceededAt?.toISOString() ?? null,
      error,
      errorDetail: error ? (row?.updateCheckErrorDetail ?? null) : null,
      source: this.config.VELNOX_UPDATE_MANIFEST_URL,
    };
  }

  /**
   * Switch the check on or off. Switching it on forgets the last attempt, so
   * the worker asks within a quarter of an hour instead of six hours after it.
   */
  async setEnabled(enabled: boolean, actor: Actor): Promise<UpdateStatusResponse> {
    const before = await this.status();
    await withSystemScope('the update check is installation-wide', () =>
      this.prisma.client.systemSettings.update({
        where: { id: 1 },
        data: enabled ? { updateCheckEnabled: true, updateCheckedAt: null } : { updateCheckEnabled: false },
      }),
    );
    if (before.enabled !== enabled) {
      await this.audit.success(AUDIT_ACTIONS.systemUpdateCheckChanged, {
        actorType: 'USER',
        actorId: actor.id,
        actorLabel: actor.email,
        resourceType: 'system_settings',
        resourceLabel: 'Update check',
        metadata: { enabled, source: this.config.VELNOX_UPDATE_MANIFEST_URL },
      });
    }
    return this.status();
  }

  /** Read the release file now, through the worker, and return what it found. */
  async checkNow(): Promise<UpdateStatusResponse> {
    try {
      await this.queue.runAndWait(JOB_NAMES.updateCheck, {}, CHECK_TIMEOUT_MS);
    } catch (error) {
      // The read itself does not throw — a failed read is recorded and shown.
      // Reaching here means the worker did not answer.
      throw new VelnoxError(ERROR_CODES.velnoxUpdateCheckUnanswered, {
        status: 504,
        message: error instanceof Error ? error.message.slice(0, 300) : undefined,
      });
    }
    return this.status();
  }
}

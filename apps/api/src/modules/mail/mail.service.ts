import { Injectable } from '@nestjs/common';
import { withSystemScope } from '@velnox/db';
import { ERROR_CODES, JOB_NAMES, VelnoxError } from '@velnox/shared';
import { PrismaService } from '../infrastructure/prisma.service';
import { QueueService } from '../infrastructure/queue.service';
import { SecretStoreService } from '../auth/secret-store.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import type { Actor } from '../../common/actor';

export type SmtpSecurityMode = 'STARTTLS' | 'TLS' | 'NONE';

export interface MailSettings {
  enabled: boolean;
  host: string | null;
  port: number;
  security: SmtpSecurityMode;
  username: string | null;
  /** Whether a password is stored. Never the password. */
  passwordSet: boolean;
  from: string | null;
  /** When a test mail last went out with exactly these settings. */
  verifiedAt: string | null;
}

export interface MailSettingsInput {
  host?: string | null;
  port?: number;
  security?: SmtpSecurityMode;
  username?: string | null;
  /** A new password; null removes it; absent keeps it. */
  password?: string | null;
  from?: string | null;
  enabled?: boolean;
}

const TEST_TIMEOUT_MS = 45_000;

/**
 * Outgoing mail, Velnox's first way of reaching someone who is not looking at it.
 *
 * The API stores the settings and the password, and never reads the password
 * back: the worker sends every mail, test included, because the worker is what
 * may decrypt it (ADR-009). So a test here is a request to the worker, waited
 * for, like reading a cluster's certificate.
 *
 * **Enabled means proven.** Changing anything about the connection clears the
 * proof, and mail cannot be switched on until a test has gone out with the
 * settings as they now are. A notification that silently fails is worse than
 * none, because someone is waiting for it.
 */
@Injectable()
export class MailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly secrets: SecretStoreService,
    private readonly audit: AuditService,
  ) {}

  private settingsRow() {
    return withSystemScope(
      'outgoing mail is installation-wide',
      async () => await this.prisma.client.systemSettings.findUniqueOrThrow({ where: { id: 1 } }),
    );
  }

  async get(): Promise<MailSettings> {
    const row = await this.settingsRow();
    return {
      enabled: row.smtpEnabled,
      host: row.smtpHost,
      port: row.smtpPort,
      security: row.smtpSecurity,
      username: row.smtpUsername,
      passwordSet: row.smtpPasswordCredentialId !== null,
      from: row.smtpFrom,
      verifiedAt: row.smtpVerifiedAt?.toISOString() ?? null,
    };
  }

  async update(input: MailSettingsInput, actor: Actor): Promise<MailSettings> {
    const row = await this.settingsRow();
    const connectionChanged =
      (input.host !== undefined && input.host !== row.smtpHost) ||
      (input.port !== undefined && input.port !== row.smtpPort) ||
      (input.security !== undefined && input.security !== row.smtpSecurity) ||
      (input.username !== undefined && input.username !== row.smtpUsername) ||
      (input.from !== undefined && input.from !== row.smtpFrom) ||
      input.password !== undefined;

    const verified = connectionChanged ? null : row.smtpVerifiedAt;
    const enabled = input.enabled ?? (connectionChanged ? false : row.smtpEnabled);
    if (enabled && !verified) {
      throw new VelnoxError(ERROR_CODES.validation, {
        status: 409,
        message: 'Send a test mail with these settings before switching mail on',
        params: { reason: 'untested' },
      });
    }

    let credentialId = row.smtpPasswordCredentialId;
    const retired: string[] = [];
    if (input.password !== undefined) {
      if (credentialId) retired.push(credentialId);
      credentialId = null;
      if (input.password !== null) {
        const stored = await this.secrets.putForCredential({
          kind: 'SMTP_PASSWORD',
          material: input.password,
          tenantId: null,
          label: 'Outgoing mail server',
          scopeType: 'GLOBAL',
        });
        credentialId = stored.credentialId;
      }
    }

    await withSystemScope(
      'outgoing mail is installation-wide',
      async () =>
        await this.prisma.client.systemSettings.update({
          where: { id: 1 },
          data: {
            ...(input.host !== undefined ? { smtpHost: input.host } : {}),
            ...(input.port !== undefined ? { smtpPort: input.port } : {}),
            ...(input.security !== undefined ? { smtpSecurity: input.security } : {}),
            ...(input.username !== undefined ? { smtpUsername: input.username } : {}),
            ...(input.from !== undefined ? { smtpFrom: input.from } : {}),
            smtpPasswordCredentialId: credentialId,
            smtpVerifiedAt: verified,
            smtpEnabled: enabled,
          },
        }),
    );
    for (const id of retired) await this.secrets.deleteCredential(id).catch(() => undefined);

    await this.audit.success(AUDIT_ACTIONS.mailSettingsChanged, {
      actorType: 'USER',
      actorId: actor.id,
      actorLabel: actor.email,
      resourceType: 'system_settings',
      resourceLabel: 'Outgoing mail',
      metadata: {
        fields: Object.keys(input).filter((key) => key !== 'password'),
        passwordChanged: input.password !== undefined,
        enabled,
      },
    });
    return this.get();
  }

  /**
   * Send one mail to `to` with the stored settings, through the worker, and
   * record that these settings work.
   */
  async test(to: string, actor: Actor): Promise<MailSettings> {
    const row = await this.settingsRow();
    if (!row.smtpHost || !row.smtpFrom) {
      throw new VelnoxError(ERROR_CODES.mailNotConfigured, { status: 409 });
    }
    const stamp = row.updatedAt.toISOString();
    try {
      await this.queue.runAndWait<{ ok: true }>(JOB_NAMES.mailTest, { to }, TEST_TIMEOUT_MS);
    } catch (error) {
      await this.audit.failure(AUDIT_ACTIONS.mailTestSent, {
        actorType: 'USER',
        actorId: actor.id,
        actorLabel: actor.email,
        resourceType: 'system_settings',
        resourceLabel: 'Outgoing mail',
        metadata: { to },
      });
      throw new VelnoxError(ERROR_CODES.mailSendFailed, {
        status: 502,
        params: { reason: error instanceof Error ? error.message.slice(0, 300) : 'unknown' },
      });
    }
    // Only if nothing changed while the test was out: the proof is for these settings.
    await withSystemScope(
      'outgoing mail is installation-wide',
      async () =>
        await this.prisma.client.systemSettings.updateMany({
          where: { id: 1, updatedAt: new Date(stamp) },
          data: { smtpVerifiedAt: new Date() },
        }),
    );
    await this.audit.success(AUDIT_ACTIONS.mailTestSent, {
      actorType: 'USER',
      actorId: actor.id,
      actorLabel: actor.email,
      resourceType: 'system_settings',
      resourceLabel: 'Outgoing mail',
      metadata: { to },
    });
    return this.get();
  }
}

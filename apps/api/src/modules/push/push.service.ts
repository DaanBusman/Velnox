import { generateKeyPairSync } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { withSystemScope } from '@velnox/db';
import {
  ERROR_CODES,
  JOB_NAMES,
  PERMISSIONS,
  PUSH_MAX_DEVICES,
  VelnoxError,
  isPushEndpoint,
} from '@velnox/shared';
import { PrismaService } from '../infrastructure/prisma.service';
import { QueueService } from '../infrastructure/queue.service';
import { SecretStoreService } from '../auth/secret-store.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import type { Actor } from '../../common/actor';

export interface PushDevice {
  endpoint: string;
  p256dh: string;
  auth: string;
  locale: 'en' | 'nl';
}

const TEST_TIMEOUT_MS = 20_000;
const SCOPE = "a person's own devices, and the installation's signing key";

/**
 * Which browsers want to be told about approvals (ADR-062).
 *
 * The API stores; the worker sends, because the API makes no outbound calls
 * and may not read these keys (ADR-009). Everything acts on the signed-in
 * account's own devices, so no tenant is involved and none is taken from the
 * request.
 */
@Injectable()
export class PushService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly secrets: SecretStoreService,
    private readonly audit: AuditService,
  ) {}

  private scoped<T>(work: () => Promise<T>): Promise<T> {
    return withSystemScope(SCOPE, work);
  }

  private assertMayApprove(actor: Actor): void {
    if (actor.grants.some((grant) => grant.permission === PERMISSIONS.jobsApprove)) return;
    throw new VelnoxError(ERROR_CODES.authzForbidden, {
      status: 403,
      params: { permission: PERMISSIONS.jobsApprove },
    });
  }

  /** The key a browser subscribes with, made the first time anyone asks. */
  async publicKey(actor: Actor): Promise<{ publicKey: string }> {
    this.assertMayApprove(actor);
    return { publicKey: await this.ensureKey() };
  }

  private async ensureKey(): Promise<string> {
    const read = () =>
      this.scoped(
        async () =>
          await this.prisma.client.systemSettings.findUniqueOrThrow({
            where: { id: 1 },
            select: { pushVapidPublicKey: true, pushVapidCredentialId: true },
          }),
      );
    const row = await read();
    if (row.pushVapidPublicKey && row.pushVapidCredentialId) return row.pushVapidPublicKey;

    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = publicKey.export({ format: 'jwk' });
    const encoded = Buffer.concat([
      Buffer.from([4]),
      Buffer.from(jwk.x as string, 'base64url'),
      Buffer.from(jwk.y as string, 'base64url'),
    ]).toString('base64url');
    const stored = await this.scoped(() =>
      this.secrets.putForCredential({
        kind: 'PUSH_VAPID_KEY',
        material: privateKey.export({ type: 'pkcs8', format: 'pem' }),
        tenantId: null,
        label: 'Notification signing key',
        scopeType: 'GLOBAL',
      }),
    );
    const won = await this.scoped(
      async () =>
        await this.prisma.client.systemSettings.updateMany({
          where: { id: 1, pushVapidCredentialId: null },
          data: { pushVapidPublicKey: encoded, pushVapidCredentialId: stored.credentialId },
        }),
    );
    if (won.count === 1) return encoded;

    // Two people at the same moment: the first key stands.
    await this.scoped(() => this.secrets.deleteCredential(stored.credentialId));
    return (await read()).pushVapidPublicKey!;
  }

  async isRegistered(endpoint: string, actor: Actor): Promise<{ registered: boolean }> {
    const row = await this.scoped(
      async () =>
        await this.prisma.client.pushSubscription.findFirst({
          where: { endpoint, userId: actor.id },
          select: { id: true },
        }),
    );
    return { registered: row !== null };
  }

  async register(device: PushDevice, actor: Actor): Promise<{ registered: true }> {
    this.assertMayApprove(actor);
    if (!isPushEndpoint(device.endpoint)) {
      throw new VelnoxError(ERROR_CODES.pushEndpointRefused, { status: 422 });
    }

    const stored = await this.scoped(() =>
      this.secrets.putForCredential({
        kind: 'PUSH_SUBSCRIPTION',
        material: device.auth,
        tenantId: null,
        label: 'Notification device',
        scopeType: 'GLOBAL',
      }),
    );
    // The same browser under another account is that account's now: one
    // browser profile is told about one person's approvals.
    const previous = await this.scoped(
      async () =>
        await this.prisma.client.pushSubscription.findUnique({
          where: { endpoint: device.endpoint },
          select: { credentialId: true },
        }),
    );
    await this.scoped(
      async () =>
        await this.prisma.client.pushSubscription.upsert({
          where: { endpoint: device.endpoint },
          create: {
            userId: actor.id,
            endpoint: device.endpoint,
            p256dh: device.p256dh,
            credentialId: stored.credentialId,
            locale: device.locale,
          },
          update: {
            userId: actor.id,
            p256dh: device.p256dh,
            credentialId: stored.credentialId,
            locale: device.locale,
          },
        }),
    );
    if (previous) await this.scoped(() => this.secrets.deleteCredential(previous.credentialId));

    const surplus = await this.scoped(
      async () =>
        await this.prisma.client.pushSubscription.findMany({
          where: { userId: actor.id },
          orderBy: { createdAt: 'desc' },
          skip: PUSH_MAX_DEVICES,
          select: { credentialId: true },
        }),
    );
    for (const row of surplus) {
      await this.scoped(() => this.secrets.deleteCredential(row.credentialId));
    }

    await this.record(AUDIT_ACTIONS.pushDeviceAdded, device.endpoint, actor);
    return { registered: true };
  }

  /** Only ever this account's: an address someone else registered stays. */
  async unregister(endpoint: string, actor: Actor): Promise<{ registered: false }> {
    const row = await this.scoped(
      async () =>
        await this.prisma.client.pushSubscription.findFirst({
          where: { endpoint, userId: actor.id },
          select: { credentialId: true },
        }),
    );
    if (row) {
      await this.scoped(() => this.secrets.deleteCredential(row.credentialId));
      await this.record(AUDIT_ACTIONS.pushDeviceRemoved, endpoint, actor);
    }
    return { registered: false };
  }

  async test(endpoint: string, actor: Actor): Promise<{ sent: true }> {
    this.assertMayApprove(actor);
    const row = await this.scoped(
      async () =>
        await this.prisma.client.pushSubscription.findFirst({
          where: { endpoint, userId: actor.id },
          select: { id: true },
        }),
    );
    if (!row) throw new VelnoxError(ERROR_CODES.pushNotRegistered, { status: 404 });

    let outcome: string;
    try {
      ({ outcome } = await this.queue.runAndWait<{ outcome: string }>(
        JOB_NAMES.pushTest,
        { subscriptionId: row.id },
        TEST_TIMEOUT_MS,
      ));
    } catch {
      // Nothing took it: most often, no worker is running.
      throw new VelnoxError(ERROR_CODES.pushWorkerUnavailable, { status: 503 });
    }
    if (outcome === 'gone') throw new VelnoxError(ERROR_CODES.pushNotRegistered, { status: 404 });
    if (outcome !== 'delivered') throw new VelnoxError(ERROR_CODES.pushSendFailed, { status: 502 });
    return { sent: true };
  }

  /** The service's name is worth recording. The address is a capability, and is not. */
  private async record(action: string, endpoint: string, actor: Actor): Promise<void> {
    await this.audit.success(action, {
      actorType: 'USER',
      actorId: actor.id,
      actorLabel: actor.email,
      resourceType: 'push_device',
      resourceLabel: new URL(endpoint).hostname,
    });
  }
}

import { withSystemScope, type VelnoxPrismaClient } from '@velnox/db';
import {
  PERMISSIONS,
  isAllowed,
  isPermission,
  isPushEndpoint,
  withSubTenantGrants,
  type Grant,
  type Permission,
  type PushMessage,
  type ScopeType,
} from '@velnox/shared';
import type { CredentialReader } from '../inventory/credentials';
import { deliver, type DeliveryOutcome, type VapidIdentity } from './web-push';

/**
 * Telling people a job waits for them (ADR-062).
 *
 * A notification grants nothing: it opens the job's page, behind the sign-in,
 * where `JobsService.decide` applies every rule it always did. Who is told is
 * still worked out carefully, because telling someone about a job they cannot
 * approve is both noise and a leak that the job exists.
 */

const APPROVAL_TTL_SECONDS = 24 * 60 * 60;
const TEST_TTL_SECONDS = 60;
const BATCH = 10;

export interface ApprovalNotice {
  jobId: string;
  tenantId: string;
  requiredPermission: string;
  requireDifferentApprover: boolean;
  requestedBy: string | null;
}

export interface Assignment {
  scopeType: string;
  scopeId: string | null;
  permissions: readonly string[];
}

/** May this account act on the approval? The API's two checks, asked in advance. */
export function mayDecide(
  grants: readonly Grant[],
  notice: Pick<ApprovalNotice, 'tenantId' | 'requiredPermission'>,
): boolean {
  const target = { tenantId: notice.tenantId };
  return (
    isAllowed(grants, PERMISSIONS.jobsApprove, target) &&
    isPermission(notice.requiredPermission) &&
    isAllowed(grants, notice.requiredPermission as Permission, target)
  );
}

export function grantsOf(
  assignments: readonly Assignment[],
  subTenantsOf: ReadonlyMap<string, readonly string[]>,
): Grant[] {
  const direct: Grant[] = [];
  for (const assignment of assignments) {
    for (const permission of assignment.permissions) {
      if (!isPermission(permission)) continue;
      direct.push({
        permission,
        scopeType: assignment.scopeType as ScopeType,
        scopeId: assignment.scopeId,
      });
    }
  }
  return withSubTenantGrants(direct, subTenantsOf);
}

export class PushSender {
  constructor(
    private readonly prisma: VelnoxPrismaClient,
    private readonly credentials: CredentialReader,
    private readonly subject: string,
    private readonly log: { warn(fields: Record<string, unknown>, message: string): void },
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private scoped<T>(work: () => Promise<T>): Promise<T> {
    return withSystemScope('approval notifications span the installation', work);
  }

  private async identity(): Promise<VapidIdentity | null> {
    const row = await this.scoped(
      async () =>
        await this.prisma.systemSettings.findUniqueOrThrow({
          where: { id: 1 },
          select: { pushVapidPublicKey: true, pushVapidCredentialId: true },
        }),
    );
    if (!row.pushVapidPublicKey || !row.pushVapidCredentialId) return null;
    return {
      publicKey: row.pushVapidPublicKey,
      privateKey: await this.credentials.pushVapidKey(row.pushVapidCredentialId),
      subject: this.subject,
    };
  }

  /** Never throws: a job must not fail because a phone could not be told. */
  async approvalRequested(notice: ApprovalNotice): Promise<void> {
    try {
      const identity = await this.identity();
      if (!identity) return; // Nobody has switched notifications on yet.

      const devices = await this.scoped(
        async () =>
          await this.prisma.pushSubscription.findMany({
            where: {
              user: {
                status: 'ACTIVE',
                deletedAt: null,
                ...(notice.requireDifferentApprover && notice.requestedBy
                  ? { id: { not: notice.requestedBy } }
                  : {}),
              },
            },
            include: {
              user: {
                select: {
                  roleAssignments: {
                    where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
                    select: {
                      scopeType: true,
                      scopeId: true,
                      role: { select: { permissions: { select: { permission: true } } } },
                    },
                  },
                },
              },
            },
          }),
      );
      if (devices.length === 0) return;

      const parents = [
        ...new Set(
          devices.flatMap((device) =>
            device.user.roleAssignments
              .filter((a) => a.scopeType === 'TENANT' && a.scopeId)
              .map((a) => a.scopeId as string),
          ),
        ),
      ];
      const subs = parents.length
        ? await this.scoped(
            async () =>
              await this.prisma.tenant.findMany({
                where: { parentTenantId: { in: parents }, deletedAt: null },
                select: { id: true, parentTenantId: true },
              }),
          )
        : [];
      const subTenantsOf = new Map<string, string[]>();
      for (const sub of subs) {
        subTenantsOf.set(sub.parentTenantId!, [...(subTenantsOf.get(sub.parentTenantId!) ?? []), sub.id]);
      }

      const allowed = devices.filter((device) =>
        mayDecide(
          grantsOf(
            device.user.roleAssignments.map((a) => ({
              scopeType: a.scopeType,
              scopeId: a.scopeId,
              permissions: a.role.permissions.map((p) => p.permission),
            })),
            subTenantsOf,
          ),
          notice,
        ),
      );

      for (let i = 0; i < allowed.length; i += BATCH) {
        await Promise.all(
          allowed.slice(i, i + BATCH).map((device) =>
            this.sendTo(
              device,
              identity,
              { v: 1, kind: 'approval', jobId: notice.jobId, lang: device.locale },
              APPROVAL_TTL_SECONDS,
              notice.jobId.replaceAll('-', ''),
            ),
          ),
        );
      }
    } catch (error) {
      this.log.warn(
        { jobId: notice.jobId, reason: error instanceof Error ? error.name : 'unknown' },
        'Could not send approval notifications',
      );
    }
  }

  /** For the button in the preferences. Throws, because the person is waiting for the answer. */
  async sendTest(subscriptionId: string): Promise<{ outcome: DeliveryOutcome }> {
    const device = await this.scoped(
      async () => await this.prisma.pushSubscription.findUnique({ where: { id: subscriptionId } }),
    );
    if (!device) throw new Error('This device is not registered');
    const identity = await this.identity();
    if (!identity) throw new Error('Notifications are not set up');
    const outcome = await this.sendTo(
      device,
      identity,
      { v: 1, kind: 'test', lang: device.locale },
      TEST_TTL_SECONDS,
    );
    return { outcome };
  }

  private async sendTo(
    device: { id: string; endpoint: string; p256dh: string; credentialId: string },
    identity: VapidIdentity,
    payload: PushMessage,
    ttlSeconds: number,
    topic?: string,
  ): Promise<DeliveryOutcome> {
    // Checked again on the way out: the row may predate a narrower list, or
    // have been written by something other than the API.
    if (!isPushEndpoint(device.endpoint)) {
      this.log.warn({ subscriptionId: device.id }, 'Refused a push address that is not a push service');
      return 'failed';
    }
    try {
      const auth = await this.credentials.pushSubscriptionAuth(device.credentialId);
      const { outcome, status } = await deliver(
        {
          endpoint: device.endpoint,
          keys: { p256dh: device.p256dh, auth },
          payload,
          ttlSeconds,
          ...(topic ? { topic } : {}),
        },
        identity,
        this.fetcher,
      );
      if (outcome === 'delivered') {
        await this.scoped(
          async () =>
            await this.prisma.pushSubscription.updateMany({
              where: { id: device.id },
              data: { lastDeliveredAt: new Date() },
            }),
        );
      } else if (outcome === 'gone') {
        await this.scoped(() => this.credentials.remove(device.credentialId));
      } else {
        // The address is a capability, so it stays out of the log.
        this.log.warn({ subscriptionId: device.id, status }, 'A push service refused a notification');
      }
      return outcome;
    } catch (error) {
      this.log.warn(
        { subscriptionId: device.id, reason: error instanceof Error ? error.name : 'unknown' },
        'Could not send a notification',
      );
      return 'failed';
    }
  }
}

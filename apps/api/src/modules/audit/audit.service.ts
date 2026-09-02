import { Inject, Injectable } from '@nestjs/common';
import type { ActorType, AuditResult, Prisma } from '@velnox/db';
import { rootRedactor } from '@velnox/shared';
import type { Logger } from 'pino';
import { PrismaService } from '../infrastructure/prisma.service';
import { ROOT_LOGGER } from '../../common/logger';
import { getRequestContext } from '../../common/request-context';

/**
 * The audit trail.
 *
 * Append-only in the database (a trigger rejects UPDATE and DELETE), and written
 * through here so every event passes the same redaction before it lands.
 *
 * Action names are stable identifiers, not prose, and they stay in English: a
 * support engineer reading a customer's audit trail must not have to guess which
 * language it was written in, and a translated action name breaks searching.
 */
export const AUDIT_ACTIONS = {
  setupInitialized: 'setup.initialized',
  setupRejected: 'setup.rejected',

  loginSucceeded: 'auth.login.succeeded',
  loginFailed: 'auth.login.failed',
  loginRateLimited: 'auth.login.rate_limited',
  logout: 'auth.logout',
  tokenRefreshed: 'auth.token.refreshed',
  tokenReuseDetected: 'auth.token.reuse_detected',

  mfaEnrolmentStarted: 'auth.mfa.enrolment_started',
  mfaEnrolled: 'auth.mfa.enrolled',
  mfaChallengeSucceeded: 'auth.mfa.challenge_succeeded',
  mfaChallengeFailed: 'auth.mfa.challenge_failed',
  mfaRecoveryCodeUsed: 'auth.mfa.recovery_code_used',
  mfaRecoveryCodesRegenerated: 'auth.mfa.recovery_codes_regenerated',
  mfaDisabled: 'auth.mfa.disabled',

  permissionDenied: 'authz.permission_denied',

  userCreated: 'user.created',
  userUpdated: 'user.updated',
  roleAssigned: 'role.assigned',
  roleRevoked: 'role.revoked',

  tenantCreated: 'tenant.created',
  identityProviderUpdated: 'identity_provider.updated',
  identityProviderTested: 'identity_provider.tested',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export interface AuditInput {
  action: AuditAction | string;
  result: AuditResult;
  actorType?: ActorType;
  actorId?: string | null;
  actorLabel?: string | null;
  tenantId?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  resourceLabel?: string | null;
  /** Never secrets. Passed through the redactor regardless. */
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Record an event.
   *
   * Never throws. An audit write that fails must not turn a successful login
   * into a 500 — but it must be loud, so the failure is logged at error level
   * with the event that was lost.
   */
  async record(input: AuditInput): Promise<void> {
    const context = getRequestContext();

    try {
      await this.prisma.client.auditEvent.create({
        data: {
          action: input.action,
          result: input.result,
          actorType: input.actorType ?? 'SYSTEM',
          actorId: input.actorId ?? null,
          actorLabel: input.actorLabel ?? null,
          tenantId: input.tenantId ?? null,
          resourceType: input.resourceType ?? null,
          resourceId: input.resourceId ?? null,
          resourceLabel: input.resourceLabel ?? null,
          ip: context?.ip ?? null,
          userAgent: context?.userAgent ?? null,
          requestId: context?.requestId ?? null,
          // Redacted before it is stored, not before it is displayed: the
          // database is where a secret would persist.
          metadata: (rootRedactor.value(input.metadata ?? {}) ?? {}) as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      this.logger.error(
        { err: rootRedactor.value(error), action: input.action, result: input.result },
        'Failed to write an audit event — the event is lost',
      );
    }
  }

  /** Convenience for the common success case. */
  success(action: AuditAction | string, input: Omit<AuditInput, 'action' | 'result'> = {}) {
    return this.record({ ...input, action, result: 'SUCCESS' });
  }

  failure(action: AuditAction | string, input: Omit<AuditInput, 'action' | 'result'> = {}) {
    return this.record({ ...input, action, result: 'FAILURE' });
  }

  denied(action: AuditAction | string, input: Omit<AuditInput, 'action' | 'result'> = {}) {
    return this.record({ ...input, action, result: 'DENIED' });
  }
}

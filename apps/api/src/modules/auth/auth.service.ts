import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { MfaPolicy, User } from '@velnox/db';
import { hashPassword, needsRehash, verifyPassword } from '@velnox/crypto';
import {
  ERROR_CODES,
  VelnoxError,
  holdsPrivilegedPermission,
  isPermission,
  type Grant,
  type ScopeType,
} from '@velnox/shared';
import { PrismaService } from '../infrastructure/prisma.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { SessionService, type SessionContext } from './session.service';
import { TokenService } from './token.service';
import { RateLimitService } from './rate-limit.service';

/**
 * Authentication.
 *
 * Every failure path — unknown account, wrong password, disabled user — returns
 * the same error and takes a comparable amount of time, so the response does not
 * reveal whether an address is registered.
 */

export interface Principal {
  user: User;
  grants: Grant[];
  isMspRoot: boolean;
  /** The policy in force for this user: the stricter of installation and tenant. */
  mfaPolicy: MfaPolicy;
  /** Whether that policy actually requires a second factor for this user. */
  mfaRequired: boolean;
}

export type LoginOutcome =
  | { status: 'authenticated'; principal: Principal; sessionId: string; accessToken: string; refreshToken: string; accessTokenExpiresAt: Date }
  | { status: 'mfa_required'; principal: Principal; sessionId: string; accessToken: string; refreshToken: string; accessTokenExpiresAt: Date }
  | { status: 'rejected' }
  | { status: 'rate_limited'; retryAfterSeconds: number };

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly rateLimit: RateLimitService,
  ) {}

  async login(
    email: string,
    password: string,
    context: SessionContext,
  ): Promise<LoginOutcome> {
    const normalisedEmail = email.trim().toLowerCase();

    const limit = await this.rateLimit.check('login', normalisedEmail, context.ip ?? 'unknown');
    if (!limit.allowed) {
      await this.audit.failure(AUDIT_ACTIONS.loginRateLimited, {
        actorType: 'ANONYMOUS',
        actorLabel: normalisedEmail,
        metadata: { retryAfterSeconds: limit.retryAfterSeconds },
      });
      return { status: 'rate_limited', retryAfterSeconds: limit.retryAfterSeconds };
    }

    const user = await this.prisma.client.user.findUnique({ where: { email: normalisedEmail } });

    // Verify against a real Argon2id hash when the account is unknown, so the
    // response time does not distinguish "no such user" from "wrong password".
    const storedHash = user?.passwordHash ?? (await dummyHash());
    const passwordOk = await verifyPassword(storedHash, password);

    const usable =
      user !== null &&
      user.deletedAt === null &&
      user.status === 'ACTIVE' &&
      user.passwordHash !== null &&
      (user.lockedUntil === null || user.lockedUntil.getTime() <= Date.now());

    if (!usable || !passwordOk) {
      await this.rateLimit.recordFailure('login', normalisedEmail, context.ip ?? 'unknown');
      if (user) {
        await this.prisma.client.user.update({
          where: { id: user.id },
          data: { failedLoginCount: { increment: 1 } },
        });
      }
      await this.audit.failure(AUDIT_ACTIONS.loginFailed, {
        actorType: 'ANONYMOUS',
        actorLabel: normalisedEmail,
        actorId: user?.id ?? null,
        tenantId: user?.tenantId ?? null,
        // Why it failed, without saying whether the account exists in the response.
        metadata: { reason: !user ? 'unknown_account' : !usable ? 'not_usable' : 'bad_password' },
      });
      return { status: 'rejected' };
    }

    await this.rateLimit.clear('login', normalisedEmail, context.ip ?? 'unknown');

    // Transparently upgrade a hash made with weaker parameters.
    if (needsRehash(user.passwordHash!)) {
      await this.prisma.client.user.update({
        where: { id: user.id },
        data: { passwordHash: await hashPassword(password) },
      });
    }

    const principal = await this.buildPrincipal(user);
    const needsSecondFactor = principal.mfaRequired && user.mfaEnrolled;

    const { session, refreshToken } = await this.sessions.create(user.id, context, {
      // A session only counts as satisfied when no second factor is owed.
      mfaSatisfied: !needsSecondFactor,
    });

    const access = this.tokens.issueAccessToken({
      sub: user.id,
      sid: session.id,
      ver: user.tokenVersion,
      mfa: !needsSecondFactor,
    });

    await this.prisma.client.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), failedLoginCount: 0 },
    });

    const common = {
      principal,
      sessionId: session.id,
      accessToken: access.token,
      refreshToken,
      accessTokenExpiresAt: access.expiresAt,
    };

    if (needsSecondFactor) {
      return { status: 'mfa_required', ...common };
    }

    await this.audit.success(AUDIT_ACTIONS.loginSucceeded, {
      actorType: 'USER',
      actorId: user.id,
      actorLabel: user.email,
      tenantId: user.tenantId,
      metadata: { mfa: user.mfaEnrolled ? 'satisfied_not_required' : 'not_enrolled' },
    });

    return { status: 'authenticated', ...common };
  }

  /**
   * Assemble everything authorisation needs for one user.
   *
   * Expired grants are filtered here rather than in each guard, and unknown
   * permission strings are dropped: a row naming a permission this build does
   * not have must not be silently treated as something else.
   */
  async buildPrincipal(user: User): Promise<Principal> {
    const [assignments, tenant, settings] = await Promise.all([
      this.prisma.client.roleAssignment.findMany({
        where: {
          userId: user.id,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        include: { role: { include: { permissions: true } } },
      }),
      this.prisma.client.tenant.findUnique({ where: { id: user.tenantId } }),
      this.prisma.client.systemSettings.findUnique({ where: { id: 1 } }),
    ]);

    const grants: Grant[] = [];
    for (const assignment of assignments) {
      for (const { permission } of assignment.role.permissions) {
        if (!isPermission(permission)) continue;
        grants.push({
          permission,
          scopeType: assignment.scopeType as ScopeType,
          scopeId: assignment.scopeId,
        });
      }
    }

    const installationPolicy = settings?.mfaPolicy ?? 'OPTIONAL';
    const tenantPolicy = readTenantMfaPolicy(tenant?.settings);
    const mfaPolicy = strictestPolicy(installationPolicy, tenantPolicy);

    return {
      user,
      grants,
      isMspRoot: tenant?.kind === 'MSP_ROOT',
      mfaPolicy,
      mfaRequired:
        mfaPolicy === 'REQUIRED' ||
        (mfaPolicy === 'REQUIRED_FOR_PRIVILEGED' && holdsPrivilegedPermission(grants)),
    };
  }

  async findPrincipalById(userId: string): Promise<Principal | null> {
    const user = await this.prisma.client.user.findUnique({ where: { id: userId } });
    if (!user || user.deletedAt || user.status !== 'ACTIVE') return null;
    return this.buildPrincipal(user);
  }

  /** Change a password, revoking every other session as a side effect. */
  async changePassword(userId: string, newPassword: string): Promise<void> {
    await this.prisma.client.user.update({
      where: { id: userId },
      data: {
        passwordHash: await hashPassword(newPassword),
        passwordUpdatedAt: new Date(),
        mustChangePassword: false,
        // Invalidates every outstanding access token without a database read.
        tokenVersion: { increment: 1 },
      },
    });
    await this.sessions.revokeAllForUser(userId, 'password_changed');
  }

  assertActiveOrThrow(principal: Principal | null): asserts principal is Principal {
    if (!principal) {
      throw new VelnoxError(ERROR_CODES.authSessionExpired, { status: 401 });
    }
  }
}

/**
 * A genuine Argon2id hash of a value nobody knows.
 *
 * It has to be real: `verifyPassword` returns false immediately for a malformed
 * hash, so a hand-written constant would make the unknown-account path fast and
 * hand an attacker exactly the account-enumeration oracle this is meant to
 * close. Computed once, lazily, and reused.
 */
let dummyHashPromise: Promise<string> | null = null;

function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(randomBytes(32).toString('base64'));
  return dummyHashPromise as Promise<string>;
}

function readTenantMfaPolicy(settings: unknown): MfaPolicy {
  if (settings && typeof settings === 'object' && 'mfaPolicy' in settings) {
    const value = (settings as { mfaPolicy?: unknown }).mfaPolicy;
    if (value === 'OPTIONAL' || value === 'REQUIRED_FOR_PRIVILEGED' || value === 'REQUIRED') {
      return value;
    }
  }
  return 'OPTIONAL';
}

const POLICY_RANK: Record<MfaPolicy, number> = {
  OPTIONAL: 0,
  REQUIRED_FOR_PRIVILEGED: 1,
  REQUIRED: 2,
};

/** The effective policy is the stricter of the two, never the looser. */
export function strictestPolicy(a: MfaPolicy, b: MfaPolicy): MfaPolicy {
  return POLICY_RANK[a] >= POLICY_RANK[b] ? a : b;
}

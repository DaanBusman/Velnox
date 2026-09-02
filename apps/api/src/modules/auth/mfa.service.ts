import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  formatSecretForDisplay,
  generateTotpSecret,
  hashPassword,
  totpUri,
  verifyPassword,
  verifyTotp,
} from '@velnox/crypto';
import { ERROR_CODES, VelnoxError } from '@velnox/shared';
import type { User } from '@velnox/db';
import type { ApiConfig } from '@velnox/config';
import type { Logger } from 'pino';
import { API_CONFIG } from '../../config/config.module';
import { ROOT_LOGGER } from '../../common/logger';
import { PrismaService } from '../infrastructure/prisma.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { SecretStoreService } from './secret-store.service';
import { SessionService } from './session.service';
import { RateLimitService } from './rate-limit.service';

/**
 * Multi-factor authentication.
 *
 * Optional by default and recommended in the interface; a policy can require it
 * for everyone or only for accounts that can change customer infrastructure.
 *
 * Two rules shape the whole flow. A factor is unusable until the user has proven
 * a working code, so a half-finished enrolment can never become the factor that
 * locks someone out. And recovery codes exist because a break-glass account has
 * to be reachable from an unexpected machine during an incident.
 */

export const RECOVERY_CODE_COUNT = 10;

export interface EnrolmentOffer {
  /** For manual entry, in the groups authenticator apps display. */
  secret: string;
  /** For the QR code. Contains the same secret. */
  uri: string;
}

@Injectable()
export class MfaService {
  private readonly issuer: string;

  constructor(
    @Inject(API_CONFIG) config: ApiConfig,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
    private readonly prisma: PrismaService,
    private readonly secrets: SecretStoreService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly rateLimit: RateLimitService,
  ) {
    this.issuer = config.VELNOX_PRODUCT_NAME;
  }

  /**
   * Begin enrolment.
   *
   * The seed goes straight into the credential store; the factor row holds only
   * a reference. The plaintext seed is returned to the caller exactly once, in
   * this response, and is never written to a log or an audit record.
   */
  async beginEnrolment(user: User): Promise<EnrolmentOffer> {
    // Replace any unconfirmed attempt, so a user who abandoned enrolment is not
    // stuck with a stale QR code.
    await this.discardUnconfirmed(user.id);

    const seed = generateTotpSecret();
    const { credentialId, secretRef } = await this.secrets.putForCredential({
      kind: 'TOTP_SEED',
      material: seed,
      tenantId: user.tenantId,
      label: `TOTP for ${user.email}`,
      username: user.email,
    });

    await this.prisma.client.userMfaFactor.create({
      data: { userId: user.id, kind: 'TOTP', secretRef, label: 'Authenticator app' },
    });

    await this.audit.success(AUDIT_ACTIONS.mfaEnrolmentStarted, {
      actorType: 'USER',
      actorId: user.id,
      actorLabel: user.email,
      tenantId: user.tenantId,
      resourceType: 'mfa_factor',
      resourceId: credentialId,
      // The seed is deliberately absent. Recording it here would put the second
      // factor in the same place as the record of using it.
    });

    return {
      secret: formatSecretForDisplay(seed),
      uri: totpUri({ secret: seed, account: user.email, issuer: this.issuer }),
    };
  }

  /**
   * Finish enrolment by proving a working code.
   *
   * Only here does the factor become usable, and only here are recovery codes
   * issued — shown once and never retrievable.
   */
  async confirmEnrolment(user: User, code: string): Promise<{ recoveryCodes: string[] }> {
    const factor = await this.prisma.client.userMfaFactor.findFirst({
      where: { userId: user.id, kind: 'TOTP', confirmedAt: null, disabledAt: null },
      orderBy: { createdAt: 'desc' },
    });

    if (!factor?.secretRef) {
      throw new VelnoxError(ERROR_CODES.validation, {
        status: 409,
        message: 'No enrolment in progress',
      });
    }

    const seed = await this.secrets.get(factor.secretRef);
    const result = verifyTotp(seed, code);

    if (!result.valid) {
      await this.audit.failure(AUDIT_ACTIONS.mfaChallengeFailed, {
        actorType: 'USER',
        actorId: user.id,
        actorLabel: user.email,
        tenantId: user.tenantId,
        metadata: { stage: 'enrolment' },
      });
      throw new VelnoxError(ERROR_CODES.authMfaInvalid, { status: 400 });
    }

    const recoveryCodes = generateRecoveryCodes();
    const hashed = await Promise.all(
      recoveryCodes.map((c) => hashPassword(normaliseRecoveryCode(c))),
    );
    const generation = await this.nextGeneration(user.id);

    await this.prisma.client.$transaction(async (tx) => {
      await tx.userMfaFactor.update({
        where: { id: factor.id },
        data: { confirmedAt: new Date(), lastUsedCounter: BigInt(result.counter ?? 0) },
      });
      await tx.mfaRecoveryCode.deleteMany({ where: { userId: user.id, usedAt: null } });
      await tx.mfaRecoveryCode.createMany({
        data: hashed.map((codeHash) => ({ userId: user.id, codeHash, generation })),
      });
      await tx.user.update({ where: { id: user.id }, data: { mfaEnrolled: true } });
    });

    await this.audit.success(AUDIT_ACTIONS.mfaEnrolled, {
      actorType: 'USER',
      actorId: user.id,
      actorLabel: user.email,
      tenantId: user.tenantId,
      // Named to survive redaction: a key containing "recoveryCode" is treated
      // as holding codes, which is the right default. This is only a count.
      metadata: { issuedCount: recoveryCodes.length },
    });

    return { recoveryCodes };
  }

  /**
   * Answer a challenge on a session that owes a second factor.
   *
   * A code is accepted once: the time step it matched is recorded, so someone
   * who shoulder-surfs a six-digit code cannot use it within its window.
   */
  async completeChallenge(user: User, sessionId: string, code: string, ip: string): Promise<void> {
    const limit = await this.rateLimit.check('mfa', user.id, ip);
    if (!limit.allowed) {
      throw new VelnoxError(ERROR_CODES.authRateLimited, {
        status: 429,
        params: { seconds: limit.retryAfterSeconds },
      });
    }

    const factor = await this.prisma.client.userMfaFactor.findFirst({
      where: { userId: user.id, kind: 'TOTP', confirmedAt: { not: null }, disabledAt: null },
    });

    if (!factor?.secretRef) {
      throw new VelnoxError(ERROR_CODES.authMfaInvalid, { status: 400 });
    }

    const seed = await this.secrets.get(factor.secretRef);
    const result = verifyTotp(seed, code);

    const replayed =
      result.valid &&
      factor.lastUsedCounter !== null &&
      BigInt(result.counter ?? 0) <= factor.lastUsedCounter;

    if (!result.valid || replayed) {
      await this.rateLimit.recordFailure('mfa', user.id, ip);
      await this.audit.failure(AUDIT_ACTIONS.mfaChallengeFailed, {
        actorType: 'USER',
        actorId: user.id,
        actorLabel: user.email,
        tenantId: user.tenantId,
        metadata: { stage: 'challenge', reason: replayed ? 'code_already_used' : 'invalid_code' },
      });
      throw new VelnoxError(ERROR_CODES.authMfaInvalid, { status: 400 });
    }

    await this.rateLimit.clear('mfa', user.id, ip);
    await this.prisma.client.userMfaFactor.update({
      where: { id: factor.id },
      data: { lastUsedAt: new Date(), lastUsedCounter: BigInt(result.counter ?? 0) },
    });
    await this.sessions.markMfaSatisfied(sessionId);

    await this.audit.success(AUDIT_ACTIONS.mfaChallengeSucceeded, {
      actorType: 'USER',
      actorId: user.id,
      actorLabel: user.email,
      tenantId: user.tenantId,
    });
  }

  /**
   * Answer a challenge with a recovery code.
   *
   * Each code works exactly once. Used codes are kept rather than deleted, so
   * the audit trail can show that a recovery path was taken — which is a signal
   * worth alerting on, not a detail to tidy away.
   */
  async useRecoveryCode(user: User, sessionId: string, code: string, ip: string): Promise<{ remaining: number }> {
    const limit = await this.rateLimit.check('recovery', user.id, ip);
    if (!limit.allowed) {
      throw new VelnoxError(ERROR_CODES.authRateLimited, {
        status: 429,
        params: { seconds: limit.retryAfterSeconds },
      });
    }

    const candidates = await this.prisma.client.mfaRecoveryCode.findMany({
      where: { userId: user.id, usedAt: null },
    });

    const normalised = normaliseRecoveryCode(code);
    let matched: (typeof candidates)[number] | null = null;
    for (const candidate of candidates) {
      // Every candidate is checked, so the time taken does not reveal position.
      if (await verifyPassword(candidate.codeHash, normalised)) matched = candidate;
    }

    if (!matched) {
      await this.rateLimit.recordFailure('recovery', user.id, ip);
      await this.audit.failure(AUDIT_ACTIONS.mfaChallengeFailed, {
        actorType: 'USER',
        actorId: user.id,
        actorLabel: user.email,
        tenantId: user.tenantId,
        metadata: { stage: 'recovery' },
      });
      throw new VelnoxError(ERROR_CODES.authMfaInvalid, { status: 400 });
    }

    // Conditional update: two simultaneous requests with the same code cannot
    // both succeed, because only one will match usedAt: null.
    const claimed = await this.prisma.client.mfaRecoveryCode.updateMany({
      where: { id: matched.id, usedAt: null },
      data: { usedAt: new Date(), usedIp: ip },
    });

    if (claimed.count === 0) {
      throw new VelnoxError(ERROR_CODES.authMfaInvalid, { status: 400 });
    }

    await this.rateLimit.clear('recovery', user.id, ip);
    await this.sessions.markMfaSatisfied(sessionId);

    const remaining = await this.prisma.client.mfaRecoveryCode.count({
      where: { userId: user.id, usedAt: null },
    });

    await this.audit.success(AUDIT_ACTIONS.mfaRecoveryCodeUsed, {
      actorType: 'USER',
      actorId: user.id,
      actorLabel: user.email,
      tenantId: user.tenantId,
      metadata: { remaining },
    });

    /*
     * Using a recovery code means someone signed in without the enrolled
     * device. That is legitimate often enough to allow and suspicious often
     * enough to notice, so it is surfaced as well as recorded.
     *
     * Velnox has no alert delivery yet — that arrives with the alerting phase,
     * and docs/known-gaps.md says so. Until then this is a warn-level event
     * with a stable name, which an operator's log pipeline can alert on today.
     */
    this.logger.warn(
      {
        event: 'auth.mfa.recovery_code_used',
        userId: user.id,
        tenantId: user.tenantId,
        remaining,
      },
      'A recovery code was used to satisfy multi-factor authentication',
    );

    if (remaining === 0) {
      this.logger.warn(
        { event: 'auth.mfa.recovery_codes_exhausted', userId: user.id },
        'The last recovery code has been used; this account has no recovery path left',
      );
    }

    return { remaining };
  }

  /** Issue a fresh set, invalidating whatever is left of the old one. */
  async regenerateRecoveryCodes(user: User): Promise<string[]> {
    const codes = generateRecoveryCodes();
    const hashed = await Promise.all(codes.map((c) => hashPassword(normaliseRecoveryCode(c))));

    const generation = await this.nextGeneration(user.id);

    await this.prisma.client.$transaction(async (tx) => {
      // Unused codes from the previous generation stop working immediately.
      // Used ones stay: they are the record that a recovery path was taken.
      await tx.mfaRecoveryCode.deleteMany({ where: { userId: user.id, usedAt: null } });
      await tx.mfaRecoveryCode.createMany({
        data: hashed.map((codeHash) => ({ userId: user.id, codeHash, generation })),
      });
    });

    await this.audit.success(AUDIT_ACTIONS.mfaRecoveryCodesRegenerated, {
      actorType: 'USER',
      actorId: user.id,
      actorLabel: user.email,
      tenantId: user.tenantId,
      metadata: { generation },
    });

    return codes;
  }

  /**
   * Remove the second factor.
   *
   * Requires a currently valid code, for the same reason a password change asks
   * for the old password: possession of an unlocked browser tab must not be
   * enough to strip an account's second factor.
   */
  async disable(user: User, code: string, ip: string): Promise<void> {
    const factor = await this.prisma.client.userMfaFactor.findFirst({
      where: { userId: user.id, kind: 'TOTP', confirmedAt: { not: null }, disabledAt: null },
    });

    if (!factor?.secretRef) {
      throw new VelnoxError(ERROR_CODES.validation, {
        status: 409,
        message: 'No active factor to disable',
      });
    }

    const limit = await this.rateLimit.check('mfa', user.id, ip);
    if (!limit.allowed) {
      throw new VelnoxError(ERROR_CODES.authRateLimited, {
        status: 429,
        params: { seconds: limit.retryAfterSeconds },
      });
    }

    const seed = await this.secrets.get(factor.secretRef);
    if (!verifyTotp(seed, code).valid) {
      await this.rateLimit.recordFailure('mfa', user.id, ip);
      await this.audit.failure(AUDIT_ACTIONS.mfaChallengeFailed, {
        actorType: 'USER',
        actorId: user.id,
        actorLabel: user.email,
        tenantId: user.tenantId,
        metadata: { stage: 'disable' },
      });
      throw new VelnoxError(ERROR_CODES.authMfaInvalid, { status: 400 });
    }

    const secret = await this.prisma.client.credentialSecret.findUnique({
      where: { id: factor.secretRef },
      select: { credentialId: true },
    });

    await this.prisma.client.$transaction(async (tx) => {
      await tx.userMfaFactor.update({
        where: { id: factor.id },
        data: { disabledAt: new Date(), secretRef: null },
      });
      await tx.mfaRecoveryCode.deleteMany({ where: { userId: user.id, usedAt: null } });
      await tx.user.update({ where: { id: user.id }, data: { mfaEnrolled: false } });
    });

    // Outside the transaction: the seed is no longer referenced, and failing to
    // delete it must not roll back the disable the user asked for.
    if (secret) await this.secrets.deleteCredential(secret.credentialId);

    await this.audit.success(AUDIT_ACTIONS.mfaDisabled, {
      actorType: 'USER',
      actorId: user.id,
      actorLabel: user.email,
      tenantId: user.tenantId,
    });
  }

  async status(userId: string) {
    const [factor, remaining] = await Promise.all([
      this.prisma.client.userMfaFactor.findFirst({
        where: { userId, kind: 'TOTP', disabledAt: null },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.client.mfaRecoveryCode.count({ where: { userId, usedAt: null } }),
    ]);

    return {
      enrolled: factor !== null && factor.confirmedAt !== null,
      enrolmentInProgress: factor !== null && factor.confirmedAt === null,
      lastUsedAt: factor?.lastUsedAt ?? null,
      recoveryCodesRemaining: remaining,
    };
  }

  private async nextGeneration(userId: string): Promise<number> {
    const latest = await this.prisma.client.mfaRecoveryCode.findFirst({
      where: { userId },
      orderBy: { generation: 'desc' },
      select: { generation: true },
    });
    return (latest?.generation ?? 0) + 1;
  }

  private async discardUnconfirmed(userId: string): Promise<void> {
    const stale = await this.prisma.client.userMfaFactor.findMany({
      where: { userId, kind: 'TOTP', confirmedAt: null },
    });
    for (const factor of stale) {
      if (factor.secretRef) {
        const secret = await this.prisma.client.credentialSecret.findUnique({
          where: { id: factor.secretRef },
          select: { credentialId: true },
        });
        if (secret) await this.secrets.deleteCredential(secret.credentialId);
      }
      await this.prisma.client.userMfaFactor.delete({ where: { id: factor.id } });
    }
  }
}

/**
 * Recovery codes.
 *
 * Base32 without the confusable characters, in two groups, so a code read off a
 * printout and typed on a phone lands correctly.
 */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const codes: string[] = [];

  for (let i = 0; i < count; i++) {
    const bytes = randomBytes(10);
    let code = '';
    for (const byte of bytes) code += alphabet[byte % alphabet.length];
    codes.push(`${code.slice(0, 5)}-${code.slice(5)}`);
  }
  return codes;
}

/**
 * The stored form of a recovery code.
 *
 * A code is *displayed* grouped with a dash, because that is what makes it
 * readable off a printout, and people retype it with or without the dash and in
 * whichever case their keyboard was in. Hashing and comparison therefore both
 * happen on this form — and it has to be both, which is the point of it being
 * one function: hashing the displayed form while comparing the stripped form
 * meant no recovery code could ever match.
 */
export function normaliseRecoveryCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}

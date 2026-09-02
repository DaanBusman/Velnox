import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Prisma, Session } from '@velnox/db';
import { PrismaService } from '../infrastructure/prisma.service';
import { REFRESH_TOKEN_TTL_SECONDS, TokenService, hashRefreshToken } from './token.service';

/**
 * Session lifecycle.
 *
 * A session is a chain of refresh tokens. Every refresh rotates: the presented
 * token is marked used and a child row is created. Presenting a token that has
 * already been rotated means two parties hold the same token — the legitimate
 * user and whoever copied it — and there is no way to tell which is which, so
 * the entire family is revoked and both must sign in again.
 *
 * That is the whole point of the family id: without it, a stolen refresh token
 * is a silent, indefinite session.
 */

export type RefreshOutcome =
  | { status: 'rotated'; session: Session; refreshToken: string }
  | { status: 'unknown' }
  | { status: 'expired' }
  | { status: 'revoked' }
  | { status: 'reused'; revokedFamily: string; sessionsRevoked: number };

export interface SessionContext {
  ip?: string | null;
  userAgent?: string | null;
}

@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
  ) {}

  /** Start a new session family. */
  async create(
    userId: string,
    context: SessionContext,
    options: { mfaSatisfied: boolean },
  ): Promise<{ session: Session; refreshToken: string }> {
    const refresh = this.tokens.issueRefreshToken();

    const session = await this.prisma.client.session.create({
      data: {
        userId,
        refreshTokenHash: refresh.hash,
        familyId: randomUUID(),
        ip: context.ip ?? null,
        userAgent: context.userAgent ?? null,
        expiresAt: refresh.expiresAt,
        mfaSatisfiedAt: options.mfaSatisfied ? new Date() : null,
      },
    });

    return { session, refreshToken: refresh.token };
  }

  /**
   * Rotate a refresh token.
   *
   * The whole operation is one transaction: detecting reuse and revoking the
   * family cannot be interleaved with another refresh on the same chain.
   */
  async rotate(presentedToken: string, context: SessionContext): Promise<RefreshOutcome> {
    const hash = hashRefreshToken(presentedToken);

    return this.prisma.client.$transaction(async (tx) => {
      const existing = await tx.session.findUnique({ where: { refreshTokenHash: hash } });
      if (!existing) return { status: 'unknown' };

      if (existing.revokedAt) {
        // Already rotated or explicitly revoked. If it was rotated, this is a
        // replay: someone is holding a token that was superseded.
        const revoked = await this.revokeFamily(
          tx,
          existing.familyId,
          'refresh_token_reuse_detected',
        );
        return { status: 'reused', revokedFamily: existing.familyId, sessionsRevoked: revoked };
      }

      if (existing.expiresAt.getTime() <= Date.now()) {
        return { status: 'expired' };
      }

      const refresh = this.tokens.issueRefreshToken();

      // Mark the presented token used before the child exists, so a crash
      // between the two leaves the family unusable rather than replayable.
      await tx.session.update({
        where: { id: existing.id },
        data: { revokedAt: new Date(), revokedReason: 'rotated', lastUsedAt: new Date() },
      });

      const session = await tx.session.create({
        data: {
          userId: existing.userId,
          refreshTokenHash: refresh.hash,
          familyId: existing.familyId,
          parentId: existing.id,
          ip: context.ip ?? existing.ip,
          userAgent: context.userAgent ?? existing.userAgent,
          // Sliding window: an active session keeps living, an idle one expires.
          expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
          mfaSatisfiedAt: existing.mfaSatisfiedAt,
        },
      });

      return { status: 'rotated', session, refreshToken: refresh.token };
    });
  }

  /** Revoke one session, for an ordinary sign-out. */
  async revoke(sessionId: string, reason: string): Promise<void> {
    await this.prisma.client.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  /** Revoke every session in a family. */
  async revokeFamilyById(familyId: string, reason: string): Promise<number> {
    return this.revokeFamily(this.prisma.client, familyId, reason);
  }

  /** Revoke every session a user has, for a password change or a forced sign-out. */
  async revokeAllForUser(userId: string, reason: string): Promise<number> {
    const { count } = await this.prisma.client.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return count;
  }

  async findActive(sessionId: string): Promise<Session | null> {
    const session = await this.prisma.client.session.findUnique({ where: { id: sessionId } });
    if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) return null;
    return session;
  }

  /** Record that this session has satisfied its second factor. */
  async markMfaSatisfied(sessionId: string): Promise<void> {
    await this.prisma.client.session.update({
      where: { id: sessionId },
      data: { mfaSatisfiedAt: new Date() },
    });
  }

  /** Remove sessions that expired long enough ago to be of no forensic use. */
  async pruneExpired(olderThanDays = 30): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
    const { count } = await this.prisma.client.session.deleteMany({
      where: { expiresAt: { lt: cutoff } },
    });
    return count;
  }

  /** Works against both the client and a transaction, so reuse detection can
   *  revoke inside the same transaction that discovered it. */
  private async revokeFamily(
    client: Prisma.TransactionClient | PrismaService['client'],
    familyId: string,
    reason: string,
  ): Promise<number> {
    const { count } = await client.session.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return count;
  }
}

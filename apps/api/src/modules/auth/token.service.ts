import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { ApiConfig } from '@velnox/config';
import { API_CONFIG } from '../../config/config.module';

/**
 * Access and refresh tokens.
 *
 * The access token is a short-lived signed JWT, so the hot path needs no
 * database read. The refresh token is opaque random bytes, stored only as a
 * SHA-256 hash — a database leak therefore yields no usable session.
 *
 * The JWT is signed here rather than through a library: it is HS256 with three
 * base64url segments, and a hand-rolled *verifier* is where JWT libraries
 * historically went wrong (accepting `alg: none`, or confusing HMAC with RSA).
 * This one accepts exactly one algorithm and rejects everything else before it
 * looks at anything, which is easier to see in forty lines than to audit in a
 * dependency.
 */

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 8 * 60 * 60;
export const REFRESH_TOKEN_BYTES = 32;

export interface AccessTokenClaims {
  /** User id. */
  sub: string;
  /** Session id, so a token can be tied to the session that issued it. */
  sid: string;
  /** Token version, invalidating outstanding tokens on password or role change. */
  ver: number;
  /** Whether this session has satisfied a required second factor. */
  mfa: boolean;
  iat: number;
  exp: number;
  iss: string;
}

const b64url = (input: Buffer | string): string =>
  Buffer.from(input as never)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const fromB64url = (input: string): Buffer =>
  Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export type TokenFailure =
  | 'malformed'
  | 'unsupported_algorithm'
  | 'bad_signature'
  | 'expired'
  | 'wrong_issuer';

export type VerifyResult =
  | { ok: true; claims: AccessTokenClaims }
  | { ok: false; reason: TokenFailure };

@Injectable()
export class TokenService {
  private readonly key: Buffer;
  private readonly issuer = 'velnox';

  constructor(@Inject(API_CONFIG) config: ApiConfig) {
    this.key = Buffer.from(config.JWT_SECRET, 'utf8');
  }

  issueAccessToken(
    input: Pick<AccessTokenClaims, 'sub' | 'sid' | 'ver' | 'mfa'>,
    now = Math.floor(Date.now() / 1000),
  ): { token: string; expiresAt: Date } {
    const claims: AccessTokenClaims = {
      ...input,
      iat: now,
      exp: now + ACCESS_TOKEN_TTL_SECONDS,
      iss: this.issuer,
    };

    const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = b64url(JSON.stringify(claims));
    const signature = this.sign(`${header}.${payload}`);

    return {
      token: `${header}.${payload}.${signature}`,
      expiresAt: new Date(claims.exp * 1000),
    };
  }

  verifyAccessToken(token: string, now = Math.floor(Date.now() / 1000)): VerifyResult {
    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'malformed' };
    const [header, payload, signature] = parts as [string, string, string];

    let parsedHeader: { alg?: unknown; typ?: unknown };
    try {
      parsedHeader = JSON.parse(fromB64url(header).toString('utf8'));
    } catch {
      return { ok: false, reason: 'malformed' };
    }

    // Checked before the signature, so `alg: none` and algorithm confusion are
    // rejected without the key ever being used.
    if (parsedHeader.alg !== 'HS256') return { ok: false, reason: 'unsupported_algorithm' };

    const expected = Buffer.from(this.sign(`${header}.${payload}`), 'utf8');
    const provided = Buffer.from(signature, 'utf8');
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      return { ok: false, reason: 'bad_signature' };
    }

    let claims: AccessTokenClaims;
    try {
      claims = JSON.parse(fromB64url(payload).toString('utf8'));
    } catch {
      return { ok: false, reason: 'malformed' };
    }

    if (
      typeof claims.sub !== 'string' ||
      typeof claims.sid !== 'string' ||
      typeof claims.ver !== 'number' ||
      typeof claims.exp !== 'number'
    ) {
      return { ok: false, reason: 'malformed' };
    }
    if (claims.iss !== this.issuer) return { ok: false, reason: 'wrong_issuer' };
    if (claims.exp <= now) return { ok: false, reason: 'expired' };

    return { ok: true, claims };
  }

  private sign(data: string): string {
    return b64url(createHmac('sha256', this.key).update(data).digest());
  }

  // --- refresh tokens ------------------------------------------------------

  /** A fresh opaque refresh token and the hash to store alongside the session. */
  issueRefreshToken(): { token: string; hash: string; expiresAt: Date } {
    const token = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
    return {
      token,
      hash: hashRefreshToken(token),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
    };
  }
}

/**
 * SHA-256, deliberately not Argon2id.
 *
 * A refresh token is 256 bits of CSPRNG output, not a human-chosen secret, so
 * there is nothing to brute-force and no need for a slow hash — and the lookup
 * happens on every refresh, where a 64 MiB hash would be a denial-of-service
 * vector against ourselves.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

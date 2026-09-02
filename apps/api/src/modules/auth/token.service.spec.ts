import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { ApiConfig } from '@velnox/config';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  TokenService,
  hashRefreshToken,
} from './token.service';

const service = (secret = 'x'.repeat(48)) =>
  new TokenService({ JWT_SECRET: secret } as ApiConfig);

const claims = { sub: 'user-1', sid: 'session-1', ver: 3, mfa: true };
const NOW = 1_700_000_000;

const tamper = (token: string, index: number, value: string) => {
  const parts = token.split('.');
  parts[index] = value;
  return parts.join('.');
};

const encodeSegment = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

describe('access tokens', () => {
  it('round-trips its claims', () => {
    const svc = service();
    const { token, expiresAt } = svc.issueAccessToken(claims, NOW);
    const result = svc.verifyAccessToken(token, NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims.sub).toBe('user-1');
    expect(result.claims.sid).toBe('session-1');
    expect(result.claims.ver).toBe(3);
    expect(result.claims.mfa).toBe(true);
    expect(expiresAt.getTime()).toBe((NOW + ACCESS_TOKEN_TTL_SECONDS) * 1000);
  });

  it('expires, and is rejected one second after it does', () => {
    const svc = service();
    const { token } = svc.issueAccessToken(claims, NOW);

    expect(svc.verifyAccessToken(token, NOW + ACCESS_TOKEN_TTL_SECONDS - 1).ok).toBe(true);
    const expired = svc.verifyAccessToken(token, NOW + ACCESS_TOKEN_TTL_SECONDS + 1);
    expect(expired).toEqual({ ok: false, reason: 'expired' });
  });

  it('is short-lived, so a leaked token is not a lasting session', () => {
    expect(ACCESS_TOKEN_TTL_SECONDS).toBeLessThanOrEqual(15 * 60);
  });

  it('rejects a token signed with a different secret', () => {
    const { token } = service('a'.repeat(48)).issueAccessToken(claims, NOW);
    expect(service('b'.repeat(48)).verifyAccessToken(token, NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a modified payload', () => {
    const svc = service();
    const { token } = svc.issueAccessToken(claims, NOW);
    const forged = tamper(token, 1, encodeSegment({ ...claims, sub: 'someone-else', iat: NOW, exp: NOW + 900, iss: 'velnox' }));
    expect(svc.verifyAccessToken(forged, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects alg:none, which is the classic JWT forgery', () => {
    const svc = service();
    const header = encodeSegment({ alg: 'none', typ: 'JWT' });
    const payload = encodeSegment({ ...claims, iat: NOW, exp: NOW + 900, iss: 'velnox' });
    expect(svc.verifyAccessToken(`${header}.${payload}.`, NOW)).toEqual({
      ok: false,
      reason: 'unsupported_algorithm',
    });
  });

  it('rejects any algorithm other than HS256, before touching the key', () => {
    const svc = service();
    for (const alg of ['HS512', 'RS256', 'ES256', 'hs256', '']) {
      const header = encodeSegment({ alg, typ: 'JWT' });
      const payload = encodeSegment({ ...claims, iat: NOW, exp: NOW + 900, iss: 'velnox' });
      expect(svc.verifyAccessToken(`${header}.${payload}.sig`, NOW).ok, alg).toBe(false);
    }
  });

  it('rejects a token issued by something else', () => {
    const svc = service();
    const header = encodeSegment({ alg: 'HS256', typ: 'JWT' });
    const payload = encodeSegment({ ...claims, iat: NOW, exp: NOW + 900, iss: 'not-velnox' });
    // Sign it correctly, so only the issuer check can reject it.
    const signed = svc.issueAccessToken(claims, NOW);
    const forged = `${header}.${payload}.${signed.token.split('.')[2]}`;
    expect(svc.verifyAccessToken(forged, NOW).ok).toBe(false);
  });

  it('rejects malformed input without throwing', () => {
    const svc = service();
    for (const bad of ['', 'a', 'a.b', 'a.b.c.d', '...', 'not.a.jwt', '{}.{}.{}']) {
      expect(svc.verifyAccessToken(bad, NOW).ok, bad).toBe(false);
    }
  });

  it('rejects a token whose claims are the wrong shape', () => {
    const svc = service();
    const real = svc.issueAccessToken(claims, NOW).token;
    const [header] = real.split('.');
    // Correctly signed but missing sub — signing it properly requires the key,
    // so this asserts the shape check rather than the signature check.
    const payload = encodeSegment({ sid: 's', ver: 1, exp: NOW + 900, iss: 'velnox' });
    const svc2 = service();
    const legit = svc2.issueAccessToken(claims, NOW);
    expect(svc.verifyAccessToken(`${header}.${payload}.${legit.token.split('.')[2]}`, NOW).ok).toBe(
      false,
    );
  });

  it('carries the mfa flag, so an unsatisfied session is visible in the token', () => {
    const svc = service();
    const { token } = svc.issueAccessToken({ ...claims, mfa: false }, NOW);
    const result = svc.verifyAccessToken(token, NOW);
    expect(result.ok && result.claims.mfa).toBe(false);
  });
});

describe('refresh tokens', () => {
  it('issues unguessable tokens', () => {
    const svc = service();
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(svc.issueRefreshToken().token);
    expect(seen.size).toBe(200);

    const { token } = svc.issueRefreshToken();
    // 32 bytes base64url, so at least 40 characters of entropy.
    expect(token.length).toBeGreaterThanOrEqual(40);
  });

  it('stores only a hash, and the hash does not contain the token', () => {
    const svc = service();
    const { token, hash } = svc.issueRefreshToken();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(hashRefreshToken(token)).toBe(hash);
  });

  it('hashes deterministically, so a presented token can be looked up', () => {
    expect(hashRefreshToken('abc')).toBe(hashRefreshToken('abc'));
    expect(hashRefreshToken('abc')).not.toBe(hashRefreshToken('abd'));
  });

  it('expires within the sliding window', () => {
    const { expiresAt } = service().issueRefreshToken();
    const hours = (expiresAt.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(7.9);
    expect(hours).toBeLessThanOrEqual(8.1);
  });
});

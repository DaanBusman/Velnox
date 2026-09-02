import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { RedisService } from '../infrastructure/redis.service';

/**
 * Rate limiting for authentication attempts.
 *
 * Counters live in Redis, keyed per account *and* per source address. Both
 * matter: per-account alone lets one host spray many accounts, per-address alone
 * lets a distributed attempt through.
 *
 * The limit is a delay, not a lockout. Locking an account on failed attempts
 * hands anyone who knows an email address a denial-of-service against that
 * person, which is a worse problem than the one it solves — so failures buy
 * increasing waiting time and nothing more.
 */

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
  failures: number;
}

interface Policy {
  /** Failures tolerated before any delay applies. */
  free: number;
  /** Seconds of delay after the first non-free failure, doubling each time. */
  baseDelaySeconds: number;
  maxDelaySeconds: number;
  /** How long a failure counts against you. */
  windowSeconds: number;
}

const POLICIES: Record<string, Policy> = {
  // Signing in: a person mistypes a password two or three times legitimately.
  login: { free: 3, baseDelaySeconds: 2, maxDelaySeconds: 300, windowSeconds: 900 },
  // A second factor is copied from a screen, so fewer honest mistakes and a
  // much smaller code space to guess — six digits is a million possibilities,
  // which is brute-forceable in minutes without this.
  mfa: { free: 2, baseDelaySeconds: 5, maxDelaySeconds: 600, windowSeconds: 900 },
  // Recovery codes are long and pasted; almost no honest failures.
  recovery: { free: 1, baseDelaySeconds: 10, maxDelaySeconds: 900, windowSeconds: 3600 },
};

@Injectable()
export class RateLimitService {
  constructor(private readonly redis: RedisService) {}

  async check(scope: string, subject: string, ip: string): Promise<RateLimitDecision> {
    const [bySubject, byIp] = await Promise.all([
      this.read(this.key(scope, 'subject', subject)),
      this.read(this.key(scope, 'ip', ip)),
    ]);

    // Whichever counter is further along decides, so an attacker cannot reset
    // their standing by switching one of the two.
    const failures = Math.max(bySubject.failures, byIp.failures);
    const blockedUntil = Math.max(bySubject.blockedUntil, byIp.blockedUntil);
    const now = Date.now();

    if (blockedUntil > now) {
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil((blockedUntil - now) / 1000),
        failures,
      };
    }

    return { allowed: true, retryAfterSeconds: 0, failures };
  }

  async recordFailure(scope: string, subject: string, ip: string): Promise<void> {
    const policy = POLICIES[scope] ?? POLICIES.login!;

    for (const key of [this.key(scope, 'subject', subject), this.key(scope, 'ip', ip)]) {
      const failures = await this.increment(key, policy.windowSeconds);

      if (failures > policy.free) {
        const delay = Math.min(
          policy.baseDelaySeconds * 2 ** (failures - policy.free - 1),
          policy.maxDelaySeconds,
        );
        await this.setBlock(key, delay);
      }
    }
  }

  /** A successful attempt clears the record for that subject and address. */
  async clear(scope: string, subject: string, ip: string): Promise<void> {
    const keys = [this.key(scope, 'subject', subject), this.key(scope, 'ip', ip)];
    await Promise.all(keys.flatMap((k) => [this.del(`${k}:n`), this.del(`${k}:until`)]));
  }

  private key(scope: string, kind: string, value: string): string {
    return `velnox:ratelimit:${scope}:${kind}:${hash(value)}`;
  }

  private async read(key: string): Promise<{ failures: number; blockedUntil: number }> {
    try {
      const [n, until] = await Promise.all([
        this.redis.client.get(`${key}:n`),
        this.redis.client.get(`${key}:until`),
      ]);
      return { failures: Number(n ?? 0), blockedUntil: Number(until ?? 0) };
    } catch {
      // Redis unavailable. Fail open rather than locking everyone out of a
      // management tool during an incident — the delay is a nuisance for an
      // attacker, not the only thing standing between them and an account.
      return { failures: 0, blockedUntil: 0 };
    }
  }

  private async increment(key: string, windowSeconds: number): Promise<number> {
    try {
      const value = await this.redis.client.incr(`${key}:n`);
      if (value === 1) await this.redis.client.expire(`${key}:n`, windowSeconds);
      return value;
    } catch {
      return 0;
    }
  }

  private async setBlock(key: string, delaySeconds: number): Promise<void> {
    try {
      await this.redis.client.set(
        `${key}:until`,
        String(Date.now() + delaySeconds * 1000),
        'EX',
        delaySeconds + 1,
      );
    } catch {
      // Same reasoning as read(): a missing Redis must not break signing in.
    }
  }

  private async del(key: string): Promise<void> {
    try {
      await this.redis.client.del(key);
    } catch {
      // Nothing to do; the counter expires on its own.
    }
  }
}

/**
 * Keys are hashed so the address of every account that has ever failed a login
 * is not sitting in Redis in plaintext.
 */
function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

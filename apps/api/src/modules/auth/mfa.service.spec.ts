import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '@velnox/crypto';
import {
  RECOVERY_CODE_COUNT,
  generateRecoveryCodes,
  normaliseRecoveryCode,
} from './mfa.service';

/**
 * Recovery codes.
 *
 * These are what stands between an engineer and a locked-out break-glass
 * account at three in the morning, so the properties worth pinning are the ones
 * that fail quietly: a code that cannot be typed back in, and a stored form that
 * does not match the form the user was shown.
 */

describe('recovery code generation', () => {
  it('issues the full set, all distinct', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
  });

  it('produces two distinct sets on two calls', () => {
    // A generator seeded once, or one accidentally made deterministic, would
    // hand every user in the installation the same recovery codes.
    const a = generateRecoveryCodes();
    const b = generateRecoveryCodes();
    expect(a.some((code) => b.includes(code))).toBe(false);
  });

  it('avoids the characters people confuse when reading a code off paper', () => {
    // No O/0, I/1 or L: a recovery code is transcribed by hand under pressure.
    const codes = generateRecoveryCodes(50).join('');
    expect(codes).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789-]+$/);
    expect(codes).not.toMatch(/[OIL01]/);
  });

  it('groups the code so it can be read back', () => {
    for (const code of generateRecoveryCodes()) {
      expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    }
  });
});

describe('recovery code normalisation', () => {
  it('accepts the code as displayed, and as a person is likely to retype it', () => {
    const canonical = normaliseRecoveryCode('F6R4N-BXHV8');
    expect(normaliseRecoveryCode('f6r4n-bxhv8')).toBe(canonical);
    expect(normaliseRecoveryCode('F6R4NBXHV8')).toBe(canonical);
    expect(normaliseRecoveryCode('  F6R4N - BXHV8  ')).toBe(canonical);
  });

  it('round-trips: what is shown to the user verifies against what is stored', async () => {
    /*
     * The regression this exists for. Codes were hashed in their displayed form
     * (with the dash) and compared in their stripped form, so every recovery
     * code was rejected — and the only way to find that out was to be locked out
     * and reach for one.
     */
    for (const shown of generateRecoveryCodes(3)) {
      const stored = await hashPassword(normaliseRecoveryCode(shown));

      expect(await verifyPassword(stored, normaliseRecoveryCode(shown))).toBe(true);
      expect(await verifyPassword(stored, normaliseRecoveryCode(shown.replace('-', '')))).toBe(true);
      expect(await verifyPassword(stored, normaliseRecoveryCode(shown.toLowerCase()))).toBe(true);
    }
  });

  it('does not make different codes collide', async () => {
    const [a, b] = generateRecoveryCodes(2) as [string, string];
    const stored = await hashPassword(normaliseRecoveryCode(a));
    expect(await verifyPassword(stored, normaliseRecoveryCode(b))).toBe(false);
  });
});

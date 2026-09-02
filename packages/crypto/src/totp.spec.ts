import { describe, expect, it } from 'vitest';
import {
  formatSecretForDisplay,
  fromBase32,
  generateTotpSecret,
  hotp,
  toBase32,
  totp,
  totpUri,
  verifyTotp,
} from './totp';

/**
 * The published test vectors. If this implementation is wrong, these fail —
 * which is the whole reason for writing TOTP rather than depending on it.
 */

describe('RFC 4226 appendix D — HOTP test vectors', () => {
  // Secret is the ASCII string "12345678901234567890".
  const secret = Buffer.from('12345678901234567890', 'ascii');
  const expected = [
    '755224',
    '287082',
    '359152',
    '969429',
    '338314',
    '254676',
    '287922',
    '162583',
    '399871',
    '520489',
  ];

  it.each(expected.map((code, counter) => [counter, code]))(
    'counter %i produces %s',
    (counter, code) => {
      expect(hotp(secret, counter as number)).toBe(code);
    },
  );
});

describe('RFC 6238 appendix B — TOTP test vectors', () => {
  const seeds = {
    sha1: Buffer.from('12345678901234567890', 'ascii'),
    sha256: Buffer.from('12345678901234567890123456789012', 'ascii'),
    sha512: Buffer.from(
      '1234567890123456789012345678901234567890123456789012345678901234',
      'ascii',
    ),
  };

  const vectors: [number, 'sha1' | 'sha256' | 'sha512', string][] = [
    [59, 'sha1', '94287082'],
    [59, 'sha256', '46119246'],
    [59, 'sha512', '90693936'],
    [1111111109, 'sha1', '07081804'],
    [1111111109, 'sha256', '68084774'],
    [1111111109, 'sha512', '25091201'],
    [1111111111, 'sha1', '14050471'],
    [1111111111, 'sha256', '67062674'],
    [1111111111, 'sha512', '99943326'],
    [1234567890, 'sha1', '89005924'],
    [1234567890, 'sha256', '91819424'],
    [1234567890, 'sha512', '93441116'],
    [2000000000, 'sha1', '69279037'],
    [2000000000, 'sha256', '90698825'],
    [2000000000, 'sha512', '38618901'],
    [20000000000, 'sha1', '65353130'],
    [20000000000, 'sha256', '77737706'],
    [20000000000, 'sha512', '47863826'],
  ];

  it.each(vectors)('t=%i %s produces %s', (time, algorithm, code) => {
    expect(totp(seeds[algorithm], { now: time as number, algorithm, digits: 8 })).toBe(code);
  });
});

describe('base32', () => {
  // RFC 4648 section 10 vectors, without padding.
  it.each([
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ])('encodes %o as %s', (input, encoded) => {
    expect(toBase32(Buffer.from(input, 'ascii'))).toBe(encoded);
  });

  it('round-trips arbitrary bytes', () => {
    for (let length = 1; length <= 40; length++) {
      const bytes = generateTotpSecret(length);
      expect(fromBase32(toBase32(bytes)).equals(bytes)).toBe(true);
    }
  });

  it('accepts what an operator actually pastes back', () => {
    const secret = generateTotpSecret();
    const displayed = formatSecretForDisplay(secret); // spaced in groups of four
    expect(fromBase32(displayed).equals(secret)).toBe(true);
    expect(fromBase32(toBase32(secret).toLowerCase()).equals(secret)).toBe(true);
    expect(fromBase32(`${toBase32(secret)}======`).equals(secret)).toBe(true);
  });

  it('rejects characters that are not base32', () => {
    expect(() => fromBase32('MZXW6!')).toThrow(/base32/);
    // 0, 1 and 8 are excluded from the alphabet precisely to avoid O/I/B confusion.
    expect(() => fromBase32('MZXW01')).toThrow(/base32/);
  });
});

describe('verifyTotp', () => {
  const secret = Buffer.from('12345678901234567890', 'ascii');
  const now = 1_700_000_000;

  it('accepts the current code', () => {
    const code = totp(secret, { now });
    const result = verifyTotp(secret, code, { now });
    expect(result.valid).toBe(true);
    expect(result.delta).toBe(0);
    expect(result.counter).toBe(Math.floor(now / 30));
  });

  it('tolerates one step of drift in each direction', () => {
    expect(verifyTotp(secret, totp(secret, { now: now - 30 }), { now }).delta).toBe(-1);
    expect(verifyTotp(secret, totp(secret, { now: now + 30 }), { now }).delta).toBe(1);
  });

  it('rejects drift beyond the window', () => {
    expect(verifyTotp(secret, totp(secret, { now: now - 90 }), { now }).valid).toBe(false);
    expect(verifyTotp(secret, totp(secret, { now: now + 90 }), { now }).valid).toBe(false);
  });

  it('reports the counter so a used step can be blocked from replay', () => {
    const previous = verifyTotp(secret, totp(secret, { now: now - 30 }), { now });
    expect(previous.counter).toBe(Math.floor(now / 30) - 1);
  });

  it('rejects a wrong code', () => {
    expect(verifyTotp(secret, '000000', { now }).valid).toBe(false);
  });

  it('rejects malformed input without throwing', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56', '-12345']) {
      expect(verifyTotp(secret, bad, { now }).valid, bad).toBe(false);
    }
  });

  it('accepts a code the user typed with a space in it', () => {
    const code = totp(secret, { now });
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(verifyTotp(secret, spaced, { now }).valid).toBe(true);
  });

  it('rejects a code generated from a different secret', () => {
    expect(verifyTotp(secret, totp(generateTotpSecret(), { now }), { now }).valid).toBe(false);
  });

  it('can be narrowed to no tolerance at all', () => {
    expect(verifyTotp(secret, totp(secret, { now: now - 30 }), { now, window: 0 }).valid).toBe(false);
    expect(verifyTotp(secret, totp(secret, { now }), { now, window: 0 }).valid).toBe(true);
  });
});

describe('enrolment', () => {
  it('generates a 20-byte secret by default', () => {
    expect(generateTotpSecret()).toHaveLength(20);
    expect(generateTotpSecret().equals(generateTotpSecret())).toBe(false);
  });

  it('builds an otpauth URI an authenticator app can read', () => {
    const secret = Buffer.from('12345678901234567890', 'ascii');
    const uri = totpUri({ secret, account: 'ops@example.com', issuer: 'Velnox' });
    const url = new URL(uri);

    expect(url.protocol).toBe('otpauth:');
    expect(uri.startsWith('otpauth://totp/Velnox%3Aops%40example.com?')).toBe(true);
    expect(url.searchParams.get('secret')).toBe(toBase32(secret));
    expect(url.searchParams.get('issuer')).toBe('Velnox');
    expect(url.searchParams.get('algorithm')).toBe('SHA1');
    expect(url.searchParams.get('digits')).toBe('6');
    expect(url.searchParams.get('period')).toBe('30');
  });

  it('produces a URI whose secret verifies against the generated code', () => {
    const secret = generateTotpSecret();
    const uri = totpUri({ secret, account: 'a@b.c', issuer: 'Velnox' });
    const parsed = fromBase32(new URL(uri).searchParams.get('secret')!);
    const now = 1_700_000_000;
    expect(verifyTotp(parsed, totp(secret, { now }), { now }).valid).toBe(true);
  });
});

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238) over HOTP (RFC 4226).
 *
 * Implemented here rather than pulled in, for two reasons: it is about forty
 * lines of well-specified arithmetic, and both RFCs publish test vectors, so
 * "it is correct" is something the test suite demonstrates rather than something
 * a dependency asserts. See totp.spec.ts, which runs the published vectors for
 * SHA-1, SHA-256 and SHA-512.
 *
 * SHA-1 is the default. Not because it is the strongest hash, but because
 * authenticator apps overwhelmingly implement only SHA-1 and a seed they cannot
 * read is worse than a hash with no practical attack in this construction —
 * HMAC-SHA-1 is not affected by SHA-1's collision weaknesses.
 */

export type TotpAlgorithm = 'sha1' | 'sha256' | 'sha512';

export interface TotpOptions {
  /** Seconds per code. 30 is what every authenticator app assumes. */
  period?: number;
  digits?: number;
  algorithm?: TotpAlgorithm;
  /** Unix time in seconds. Injectable so tests are not clock-dependent. */
  now?: number;
}

export const TOTP_DEFAULTS = {
  period: 30,
  digits: 6,
  algorithm: 'sha1' as TotpAlgorithm,
  /** Steps of tolerance either side, for clock drift between phone and server. */
  window: 1,
  /** 20 bytes: the size RFC 4226 recommends and every app accepts. */
  secretBytes: 20,
};

// --- base32, RFC 4648 without padding ---------------------------------------

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function toBase32(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function fromBase32(input: string): Buffer {
  // Authenticator apps display the secret in groups; operators paste it back
  // with the spaces and sometimes with padding.
  const clean = input.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`Not valid base32: "${char}"`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// --- HOTP / TOTP ------------------------------------------------------------

/** RFC 4226 section 5: HMAC, dynamic truncation, modulo 10^digits. */
export function hotp(secret: Buffer, counter: number, options: TotpOptions = {}): string {
  const digits = options.digits ?? TOTP_DEFAULTS.digits;
  const algorithm = options.algorithm ?? TOTP_DEFAULTS.algorithm;

  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac(algorithm, secret).update(counterBytes).digest();

  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

export function totp(secret: Buffer, options: TotpOptions = {}): string {
  const period = options.period ?? TOTP_DEFAULTS.period;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  return hotp(secret, Math.floor(now / period), options);
}

export interface TotpVerifyResult {
  valid: boolean;
  /**
   * Which time step matched, relative to now. Zero is the current step; -1 is
   * the previous one. The caller stores it so the same step cannot be replayed.
   */
  delta: number;
  /** Absolute counter value of the matching step, for replay prevention. */
  counter: number | null;
}

/**
 * Verify a submitted code.
 *
 * Every candidate step is compared in constant time, and the loop does not
 * short-circuit, so the time taken does not reveal which step matched.
 */
export function verifyTotp(
  secret: Buffer,
  token: string,
  options: TotpOptions & { window?: number } = {},
): TotpVerifyResult {
  const digits = options.digits ?? TOTP_DEFAULTS.digits;
  const period = options.period ?? TOTP_DEFAULTS.period;
  const window = options.window ?? TOTP_DEFAULTS.window;
  const now = options.now ?? Math.floor(Date.now() / 1000);

  const candidate = token.replace(/[\s-]/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(candidate)) {
    return { valid: false, delta: 0, counter: null };
  }

  const current = Math.floor(now / period);
  const submitted = Buffer.from(candidate, 'utf8');
  let matchedDelta: number | null = null;

  for (let delta = -window; delta <= window; delta++) {
    const expected = Buffer.from(hotp(secret, current + delta, options), 'utf8');
    if (expected.length === submitted.length && timingSafeEqual(expected, submitted)) {
      matchedDelta = delta;
    }
  }

  return matchedDelta === null
    ? { valid: false, delta: 0, counter: null }
    : { valid: true, delta: matchedDelta, counter: current + matchedDelta };
}

// --- Enrolment --------------------------------------------------------------

export const generateTotpSecret = (bytes = TOTP_DEFAULTS.secretBytes): Buffer => randomBytes(bytes);

/**
 * The `otpauth://` URI an authenticator app reads from a QR code.
 *
 * The issuer appears both as a label prefix and as a parameter, which is what
 * the de-facto specification requires for apps to group accounts correctly.
 */
export function totpUri(params: {
  secret: Buffer;
  account: string;
  issuer: string;
  period?: number;
  digits?: number;
  algorithm?: TotpAlgorithm;
}): string {
  const { secret, account, issuer } = params;
  const label = encodeURIComponent(`${issuer}:${account}`);
  const query = new URLSearchParams({
    secret: toBase32(secret),
    issuer,
    algorithm: (params.algorithm ?? TOTP_DEFAULTS.algorithm).toUpperCase(),
    digits: String(params.digits ?? TOTP_DEFAULTS.digits),
    period: String(params.period ?? TOTP_DEFAULTS.period),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

/** Groups of four, the way authenticator apps display a secret for manual entry. */
export const formatSecretForDisplay = (secret: Buffer): string =>
  toBase32(secret).replace(/(.{4})/g, '$1 ').trim();

import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  CURRENT_KEY_VERSION,
  DecryptionError,
  decodeMasterKey,
  decryptSecret,
  deriveKek,
  encryptSecret,
  rewrapSecret,
  safeEquals,
} from './envelope';

const master = () => randomBytes(32);

describe('master key handling', () => {
  it('decodes a correctly sized base64 key', () => {
    const key = randomBytes(32);
    expect(decodeMasterKey(key.toString('base64')).equals(key)).toBe(true);
  });

  it('refuses a key that is not 32 bytes', () => {
    expect(() => decodeMasterKey(randomBytes(16).toString('base64'))).toThrow(/32 bytes, got 16/);
    expect(() => decodeMasterKey('')).toThrow(/32 bytes/);
  });

  it('derives a different key-encryption key per version', () => {
    const m = master();
    expect(deriveKek(m, 1).equals(deriveKek(m, 2))).toBe(false);
    expect(deriveKek(m, 1).equals(deriveKek(m, 1))).toBe(true);
  });

  it('never uses the master key itself as the cipher key', () => {
    const m = master();
    expect(deriveKek(m).equals(m)).toBe(false);
  });
});

describe('encrypt and decrypt', () => {
  it('round-trips secret material', () => {
    const m = master();
    const plaintext = 'root-password-that-must-survive';
    expect(decryptSecret(m, encryptSecret(m, plaintext)).toString('utf8')).toBe(plaintext);
  });

  it('round-trips binary material such as a TOTP seed', () => {
    const m = master();
    const seed = randomBytes(20);
    expect(decryptSecret(m, encryptSecret(m, seed)).equals(seed)).toBe(true);
  });

  it('produces different ciphertext every time, so equal secrets are not detectable', () => {
    const m = master();
    const a = encryptSecret(m, 'same');
    const b = encryptSecret(m, 'same');
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.wrappedDek.equals(b.wrappedDek)).toBe(false);
    expect(a.iv.equals(b.iv)).toBe(false);
  });

  it('gives each secret its own data key', () => {
    const m = master();
    expect(encryptSecret(m, 'a').wrappedDek.equals(encryptSecret(m, 'a').wrappedDek)).toBe(false);
  });

  it('stores no plaintext anywhere in the record', () => {
    const secret = encryptSecret(master(), 'needle-in-the-haystack');
    const serialised = Object.values(secret)
      .map((v) => (Buffer.isBuffer(v) ? v.toString('binary') : String(v)))
      .join('|');
    expect(serialised).not.toContain('needle');
  });
});

describe('tamper detection', () => {
  it('refuses a modified ciphertext', () => {
    const m = master();
    const secret = encryptSecret(m, 'original');
    secret.ciphertext[0] ^= 0xff;
    expect(() => decryptSecret(m, secret)).toThrow(DecryptionError);
  });

  it('refuses a modified authentication tag', () => {
    const m = master();
    const secret = encryptSecret(m, 'original');
    secret.authTag[0] ^= 0xff;
    expect(() => decryptSecret(m, secret)).toThrow(DecryptionError);
  });

  it('refuses a swapped wrapped data key', () => {
    const m = master();
    const a = encryptSecret(m, 'secret-a');
    const b = encryptSecret(m, 'secret-b');
    // Someone with database access moves one row's data key onto another row.
    expect(() => decryptSecret(m, { ...a, wrappedDek: b.wrappedDek, dekIv: b.dekIv, dekAuthTag: b.dekAuthTag })).toThrow(
      DecryptionError,
    );
  });

  it('refuses the wrong master key', () => {
    const secret = encryptSecret(master(), 'original');
    expect(() => decryptSecret(master(), secret)).toThrow(DecryptionError);
  });

  it('refuses an unknown algorithm rather than guessing', () => {
    const m = master();
    const secret = { ...encryptSecret(m, 'x'), algorithm: 'aes-128-cbc' };
    expect(() => decryptSecret(m, secret)).toThrow(/Unsupported algorithm/);
  });
});

describe('associated data', () => {
  it('binds a secret to its context', () => {
    const m = master();
    const secret = encryptSecret(m, 'tied-to-a-credential', { aad: 'credential:abc' });

    expect(decryptSecret(m, secret, { aad: 'credential:abc' }).toString()).toBe(
      'tied-to-a-credential',
    );
    // Moving the row to another credential must not decrypt.
    expect(() => decryptSecret(m, secret, { aad: 'credential:xyz' })).toThrow(DecryptionError);
    expect(() => decryptSecret(m, secret)).toThrow(DecryptionError);
  });
});

describe('rewrap', () => {
  it('re-encrypts under a new master key without changing the payload', () => {
    const oldKey = master();
    const newKey = master();
    const secret = encryptSecret(oldKey, 'survives-rotation');

    const rewrapped = rewrapSecret(oldKey, newKey, secret);

    // The payload bytes are untouched — that is the point of the envelope.
    expect(rewrapped.ciphertext.equals(secret.ciphertext)).toBe(true);
    expect(rewrapped.wrappedDek.equals(secret.wrappedDek)).toBe(false);

    expect(decryptSecret(newKey, rewrapped).toString()).toBe('survives-rotation');
    expect(() => decryptSecret(oldKey, rewrapped)).toThrow(DecryptionError);
  });

  it('preserves associated data across a rotation', () => {
    const oldKey = master();
    const newKey = master();
    const secret = encryptSecret(oldKey, 'bound', { aad: 'credential:1' });
    const rewrapped = rewrapSecret(oldKey, newKey, secret);
    expect(decryptSecret(newKey, rewrapped, { aad: 'credential:1' }).toString()).toBe('bound');
  });

  it('records the new key version', () => {
    const oldKey = master();
    const newKey = master();
    const rewrapped = rewrapSecret(oldKey, newKey, encryptSecret(oldKey, 'x'), 2);
    expect(rewrapped.keyVersion).toBe(2);
    expect(decryptSecret(newKey, rewrapped).toString()).toBe('x');
  });

  it('still decrypts material written under an older key version', () => {
    const m = master();
    const old = encryptSecret(m, 'legacy', { keyVersion: 1 });
    expect(old.keyVersion).toBe(1);
    expect(decryptSecret(m, old).toString()).toBe('legacy');
    expect(CURRENT_KEY_VERSION).toBeGreaterThanOrEqual(1);
  });
});

describe('safeEquals', () => {
  it('compares equal and unequal values', () => {
    expect(safeEquals('abc', 'abc')).toBe(true);
    expect(safeEquals('abc', 'abd')).toBe(false);
    expect(safeEquals('abc', 'abcd')).toBe(false);
    expect(safeEquals(Buffer.from('x'), Buffer.from('x'))).toBe(true);
  });
});

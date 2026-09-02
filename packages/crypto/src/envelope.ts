import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Envelope encryption for stored secrets.
 *
 *   MASTER_ENCRYPTION_KEY (32 bytes)
 *        │  HKDF-SHA256, info = "velnox/kek/v<version>"
 *        ▼
 *      KEK ──AES-256-GCM──► wrapped DEK   (random 32 bytes, one per secret)
 *                                │
 *                                ▼
 *                    AES-256-GCM(secret material)
 *
 * A data key per secret rather than encrypting everything under the master key
 * directly, because it makes key rotation cheap: rewrapping touches only the
 * 32-byte data keys, never the payloads, and a future KMS can take over the
 * wrapping step without a single call site changing.
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96 bits, the size GCM is specified for
const TAG_BYTES = 16;

/** The current key derivation. Stored per secret so old material stays readable. */
export const CURRENT_KEY_VERSION = 1;

export interface EncryptedSecret {
  /** The secret, encrypted under its own data key. */
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  /** The data key, encrypted under the key-encryption key. */
  wrappedDek: Buffer;
  dekIv: Buffer;
  dekAuthTag: Buffer;
  keyVersion: number;
  algorithm: string;
}

export class DecryptionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DecryptionError';
  }
}

function assertMasterKey(masterKey: Buffer): void {
  if (masterKey.length !== KEY_BYTES) {
    throw new Error(
      `Master encryption key must be ${KEY_BYTES} bytes, got ${masterKey.length}. ` +
        'Generate one with: openssl rand -base64 32',
    );
  }
}

/** Decode MASTER_ENCRYPTION_KEY from its configured base64 form. */
export function decodeMasterKey(base64: string): Buffer {
  const key = Buffer.from(base64, 'base64');
  assertMasterKey(key);
  return key;
}

/**
 * Derive the key-encryption key.
 *
 * HKDF rather than using the master key directly: the master key is never used
 * as a cipher key, so a future second purpose (signing, a different store) gets
 * its own derived key from the same root without the two ever colliding.
 */
export function deriveKek(masterKey: Buffer, keyVersion = CURRENT_KEY_VERSION): Buffer {
  assertMasterKey(masterKey);
  const derived = hkdfSync(
    'sha256',
    masterKey,
    Buffer.alloc(0),
    Buffer.from(`velnox/kek/v${keyVersion}`, 'utf8'),
    KEY_BYTES,
  );
  return Buffer.from(derived);
}

function encryptWith(key: Buffer, plaintext: Buffer, aad?: Buffer) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  if (aad) cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

function decryptWith(
  key: Buffer,
  ciphertext: Buffer,
  iv: Buffer,
  authTag: Buffer,
  aad?: Buffer,
): Buffer {
  if (authTag.length !== TAG_BYTES) {
    throw new DecryptionError(`Authentication tag must be ${TAG_BYTES} bytes`);
  }
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(authTag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (cause) {
    // GCM authentication failed: wrong key, or the stored bytes were altered.
    // The message is deliberately vague — the detail is in the log, not here.
    throw new DecryptionError('Secret could not be decrypted or has been tampered with', { cause });
  }
}

/**
 * Encrypt secret material.
 *
 * `aad` binds the ciphertext to its context — pass the credential id, and the
 * stored bytes cannot be moved to a different credential row and still decrypt.
 */
export function encryptSecret(
  masterKey: Buffer,
  plaintext: string | Buffer,
  options: { aad?: string; keyVersion?: number } = {},
): EncryptedSecret {
  const keyVersion = options.keyVersion ?? CURRENT_KEY_VERSION;
  const kek = deriveKek(masterKey, keyVersion);
  const dek = randomBytes(KEY_BYTES);
  const aad = options.aad ? Buffer.from(options.aad, 'utf8') : undefined;

  try {
    const payload = encryptWith(dek, Buffer.from(plaintext as never), aad);
    const wrapped = encryptWith(kek, dek);

    return {
      ciphertext: payload.ciphertext,
      iv: payload.iv,
      authTag: payload.authTag,
      wrappedDek: wrapped.ciphertext,
      dekIv: wrapped.iv,
      dekAuthTag: wrapped.authTag,
      keyVersion,
      algorithm: ALGORITHM,
    };
  } finally {
    // The data key has no reason to linger in memory once it is wrapped.
    dek.fill(0);
    kek.fill(0);
  }
}

export function decryptSecret(
  masterKey: Buffer,
  secret: EncryptedSecret,
  options: { aad?: string } = {},
): Buffer {
  if (secret.algorithm !== ALGORITHM) {
    throw new DecryptionError(`Unsupported algorithm: ${secret.algorithm}`);
  }

  const kek = deriveKek(masterKey, secret.keyVersion);
  let dek: Buffer | undefined;
  try {
    dek = decryptWith(kek, secret.wrappedDek, secret.dekIv, secret.dekAuthTag);
    const aad = options.aad ? Buffer.from(options.aad, 'utf8') : undefined;
    return decryptWith(dek, secret.ciphertext, secret.iv, secret.authTag, aad);
  } finally {
    dek?.fill(0);
    kek.fill(0);
  }
}

/**
 * Re-wrap a secret under a new master key or key version without decrypting the
 * payload's data key any longer than necessary. This is what makes master-key
 * rotation an operation on 32-byte keys instead of on every stored secret.
 */
export function rewrapSecret(
  currentMasterKey: Buffer,
  newMasterKey: Buffer,
  secret: EncryptedSecret,
  newKeyVersion = CURRENT_KEY_VERSION,
): EncryptedSecret {
  const oldKek = deriveKek(currentMasterKey, secret.keyVersion);
  const newKek = deriveKek(newMasterKey, newKeyVersion);
  let dek: Buffer | undefined;

  try {
    dek = decryptWith(oldKek, secret.wrappedDek, secret.dekIv, secret.dekAuthTag);
    const wrapped = encryptWith(newKek, dek);
    return {
      ...secret,
      wrappedDek: wrapped.ciphertext,
      dekIv: wrapped.iv,
      dekAuthTag: wrapped.authTag,
      keyVersion: newKeyVersion,
    };
  } finally {
    dek?.fill(0);
    oldKek.fill(0);
    newKek.fill(0);
  }
}

/** Constant-time comparison, for anything derived from user input. */
export function safeEquals(a: string | Buffer, b: string | Buffer): boolean {
  const left = Buffer.isBuffer(a) ? a : Buffer.from(a, 'utf8');
  const right = Buffer.isBuffer(b) ? b : Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

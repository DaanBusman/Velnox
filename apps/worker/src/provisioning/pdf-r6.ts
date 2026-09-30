import { createCipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * AES-256 PDF encryption, revision 6 — on top of what pdfkit writes.
 *
 * pdfkit encrypts with AES-256 as the 2008 Adobe extension did: revision 5,
 * whose password check is a single SHA-256. ISO 32000-2 deprecated it for
 * exactly that: checking a guess costs almost nothing, so a password someone
 * chose falls to a brute-force attack far sooner than it should. Revision 6
 * (Algorithm 2.B) makes each guess cost dozens of rounds of SHA-2 and AES.
 *
 * The two revisions encrypt the document the same way, with the same random
 * file key. They differ only in how that key is wrapped for each password —
 * the `U`, `UE`, `O` and `OE` entries — and in the number `R`. So this takes
 * pdfkit's key, which it keeps until the document ends, and rewrites those
 * entries before pdfkit writes the dictionary out.
 *
 * This reaches into pdfkit's internals (`_security`), so the pdfkit version is
 * pinned, and a test fails if the dictionary is not where it was.
 */

/** Algorithm 2.B: the revision 6 hash. */
export function hash2B(password: Buffer, salt: Buffer, userKey: Buffer): Buffer {
  let k = createHash('sha256')
    .update(Buffer.concat([password, salt, userKey]))
    .digest();
  for (let round = 0; ; round += 1) {
    const k1 = Buffer.concat(
      Array.from({ length: 64 }, () => Buffer.concat([password, k, userKey])),
    );
    const cipher = createCipheriv('aes-128-cbc', k.subarray(0, 16), k.subarray(16, 32));
    cipher.setAutoPadding(false);
    const e = Buffer.concat([cipher.update(k1), cipher.final()]);
    // The first 16 bytes as a big number, modulo 3, is the sum of the bytes modulo 3.
    let sum = 0;
    for (let i = 0; i < 16; i += 1) sum += e[i]!;
    const algorithm = ['sha256', 'sha384', 'sha512'][sum % 3]!;
    k = createHash(algorithm).update(e).digest();
    if (round >= 63 && e[e.length - 1]! <= round + 1 - 32) break;
  }
  return k.subarray(0, 32);
}

/** SASLprep is the identity for the ASCII passwords Velnox writes; UTF-8, at most 127 bytes. */
function preparePassword(password: string): Buffer {
  return Buffer.from(password.normalize('NFKC'), 'utf8').subarray(0, 127);
}

function wrapKey(key: Buffer, fileKey: Buffer): Buffer {
  const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(fileKey), cipher.final()]);
}

interface PdfKitSecurity {
  encryptionKey: Uint8Array;
  dictionary: { data: Record<string, unknown> };
}

/**
 * Rewrite a pdfkit document's encryption as revision 6. Call after the
 * document is created with `pdfVersion: '1.7ext3'` and before `end()`.
 */
export function upgradeEncryptionToR6(
  document: unknown,
  passwords: { user: string; owner: string },
): void {
  const security = (document as { _security?: PdfKitSecurity })._security;
  const dict = security?.dictionary?.data;
  if (!security || !dict || dict.R !== 5 || security.encryptionKey?.length !== 32) {
    throw new Error(
      'pdfkit did not set up AES-256 encryption where it used to; check the pinned version',
    );
  }
  const fileKey = Buffer.from(security.encryptionKey);
  const user = preparePassword(passwords.user);
  const owner = preparePassword(passwords.owner);

  const userValidationSalt = randomBytes(8);
  const userKeySalt = randomBytes(8);
  const u = Buffer.concat([
    hash2B(user, userValidationSalt, Buffer.alloc(0)),
    userValidationSalt,
    userKeySalt,
  ]);
  const ue = wrapKey(hash2B(user, userKeySalt, Buffer.alloc(0)), fileKey);

  const ownerValidationSalt = randomBytes(8);
  const ownerKeySalt = randomBytes(8);
  const o = Buffer.concat([
    hash2B(owner, ownerValidationSalt, u),
    ownerValidationSalt,
    ownerKeySalt,
  ]);
  const oe = wrapKey(hash2B(owner, ownerKeySalt, u), fileKey);

  dict.R = 6;
  dict.U = new Uint8Array(u);
  dict.UE = new Uint8Array(ue);
  dict.O = new Uint8Array(o);
  dict.OE = new Uint8Array(oe);
  // `Perms` is the permissions encrypted with the file key, the same in both revisions.
}

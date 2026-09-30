import { createHash, randomBytes } from 'node:crypto';

/**
 * SHA-512-crypt, the `$6$` password hash `/etc/shadow` and cloud-init take.
 *
 * cloud-init accepts a password in the clear, and would then write it to the
 * seed media, to its own logs on the guest, and to the instance data it keeps.
 * Handing it this hash instead means the plaintext never leaves Velnox: the
 * guest only ever sees what it stores anyway.
 *
 * Node has no implementation, and a dependency for sixty lines of a published
 * algorithm is a dependency to audit for ever. This follows Ulrich Drepper's
 * specification ("Unix crypt using SHA-256 and SHA-512", 2008) step by step,
 * and is tested against the vectors that specification gives.
 */

const ITOA64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ROUNDS_DEFAULT = 5000;
const ROUNDS_MIN = 1000;
const ROUNDS_MAX = 999_999_999;
const SALT_MAX = 16;

const sha512 = (...parts: Buffer[]): Buffer => {
  const hash = createHash('sha512');
  for (const part of parts) hash.update(part);
  return hash.digest();
};

/** `source` repeated to exactly `length` bytes. */
function stretch(source: Buffer, length: number): Buffer {
  const out = Buffer.alloc(length);
  for (let offset = 0; offset < length; offset += source.length) {
    source.copy(out, offset, 0, Math.min(source.length, length - offset));
  }
  return out;
}

/** The spec's permutation of the 64 digest bytes into 86 characters. */
const ORDER: [number, number, number][] = [
  [0, 21, 42],
  [22, 43, 1],
  [44, 2, 23],
  [3, 24, 45],
  [25, 46, 4],
  [47, 5, 26],
  [6, 27, 48],
  [28, 49, 7],
  [50, 8, 29],
  [9, 30, 51],
  [31, 52, 10],
  [53, 11, 32],
  [12, 33, 54],
  [34, 55, 13],
  [56, 14, 35],
  [15, 36, 57],
  [37, 58, 16],
  [59, 17, 38],
  [18, 39, 60],
  [40, 61, 19],
  [62, 20, 41],
];

function encode(digest: Buffer): string {
  let out = '';
  const put = (b2: number, b1: number, b0: number, n: number) => {
    let w = (b2 << 16) | (b1 << 8) | b0;
    for (let i = 0; i < n; i += 1) {
      out += ITOA64[w & 0x3f];
      w >>>= 6;
    }
  };
  for (const [a, b, c] of ORDER) put(digest[a]!, digest[b]!, digest[c]!, 4);
  put(0, 0, digest[63]!, 2);
  return out;
}

export interface Sha512CryptOptions {
  /** Up to 16 characters from `[./0-9A-Za-z]`; random when absent. */
  salt?: string;
  /** Written into the hash only when set, as the specification does. */
  rounds?: number;
}

export function sha512Crypt(password: string, options: Sha512CryptOptions = {}): string {
  const salt = (options.salt ?? randomSalt()).slice(0, SALT_MAX);
  if (!/^[./0-9A-Za-z]*$/.test(salt)) throw new Error('A crypt salt uses [./0-9A-Za-z] only');
  const customRounds = options.rounds !== undefined;
  const rounds = Math.min(
    ROUNDS_MAX,
    Math.max(ROUNDS_MIN, Math.trunc(options.rounds ?? ROUNDS_DEFAULT)),
  );

  const P = Buffer.from(password, 'utf8');
  const S = Buffer.from(salt, 'ascii');

  // Steps 4–8: digest B.
  const B = sha512(P, S, P);

  // Steps 1–3 and 9–12: digest A.
  const a = createHash('sha512');
  a.update(P);
  a.update(S);
  a.update(stretch(B, P.length));
  for (let n = P.length; n > 0; n >>>= 1) a.update(n & 1 ? B : P);
  const A = a.digest();

  // Steps 13–16: the P sequence.
  const DP = sha512(...Array.from({ length: P.length }, () => P));
  const Pseq = stretch(DP, P.length);

  // Steps 17–20: the S sequence.
  const DS = sha512(...Array.from({ length: 16 + A[0]! }, () => S));
  const Sseq = stretch(DS, S.length);

  // Step 21: the rounds.
  let C = A;
  for (let i = 0; i < rounds; i += 1) {
    const c = createHash('sha512');
    c.update(i & 1 ? Pseq : C);
    if (i % 3 !== 0) c.update(Sseq);
    if (i % 7 !== 0) c.update(Pseq);
    c.update(i & 1 ? C : Pseq);
    C = c.digest();
  }

  const prefix = customRounds ? `$6$rounds=${rounds}$` : '$6$';
  return `${prefix}${salt}$${encode(C)}`;
}

function randomSalt(): string {
  const bytes = randomBytes(SALT_MAX);
  let salt = '';
  for (const byte of bytes) salt += ITOA64[byte & 0x3f];
  return salt;
}

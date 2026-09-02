import { Algorithm, hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';

/**
 * Password hashing.
 *
 * Argon2id with parameters at the top of the OWASP recommended range that a
 * management appliance can afford: 64 MiB of memory, three passes. Memory cost
 * is what makes GPU cracking expensive, so it is the parameter to protect if any
 * of these ever need lowering.
 *
 * @node-rs/argon2 ships prebuilt binaries, so the image needs no compiler and
 * `pnpm install` needs no node-gyp.
 */
export const ARGON2_OPTIONS = {
  // Stated rather than relied upon: Argon2id is this library's default today,
  // and a default that changes underneath us would silently change every hash.
  algorithm: Algorithm.Argon2id,
  memoryCost: 65_536, // 64 MiB
  timeCost: 3,
  parallelism: 4,
  outputLen: 32,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return argon2Hash(password, ARGON2_OPTIONS);
}

/**
 * Verify a password against a stored PHC string.
 *
 * Returns false rather than throwing on a malformed hash: a corrupted row must
 * fail the login, not the request handler.
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2Verify(hash, password, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}

/**
 * Whether a stored hash was produced with weaker parameters than the current
 * ones, so it can be transparently upgraded on the next successful login.
 */
export function needsRehash(hash: string): boolean {
  const m = /\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(hash);
  if (!m) return true;
  const [, memory, time, parallelism] = m;
  return (
    Number(memory) < ARGON2_OPTIONS.memoryCost ||
    Number(time) < ARGON2_OPTIONS.timeCost ||
    Number(parallelism) < ARGON2_OPTIONS.parallelism
  );
}

// ---------------------------------------------------------------------------
// Strength
// ---------------------------------------------------------------------------

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

/**
 * Passwords that pass a length check and are still worthless.
 *
 * Deliberately short and obvious rather than a dictionary: this is a floor, not
 * a strength meter. A real check against breached-password corpora belongs
 * behind an interface that can call one, and is recorded in docs/known-gaps.md
 * rather than pretended at here.
 */
const OBVIOUS_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  'passw0rd',
  'administrator',
  'changeme',
  'letmein',
  'welcome1',
  'qwertyuiop',
  'qwerty123',
  '123456789012',
  '1234567890',
  'iloveyou',
  'monkey123',
  'proxmox',
  'velnox',
  'velnox123',
  'proxmox123',
]);

export interface PasswordCheck {
  ok: boolean;
  /** Error codes the frontend renders; never prose from the server. */
  problems: string[];
}

/**
 * A floor, not a score.
 *
 * Length does most of the work — a long passphrase beats a short password with a
 * symbol in it — so the rules ask for length and variety without demanding a
 * specific character-class recipe, which mostly teaches people to append "!".
 */
export function checkPasswordStrength(password: string, context: { email?: string } = {}): PasswordCheck {
  const problems: string[] = [];
  const value = password ?? '';

  if (value.length < PASSWORD_MIN_LENGTH) problems.push('too_short');
  if (value.length > PASSWORD_MAX_LENGTH) problems.push('too_long');

  const normalised = value.toLowerCase();
  if (OBVIOUS_PASSWORDS.has(normalised)) problems.push('too_common');

  // A single repeated character, or a straight run, however long.
  if (value.length > 0 && new Set(value).size <= 2) problems.push('too_repetitive');
  if (/^(?:0123456789|abcdefghij|qwertyuiop)/i.test(value)) problems.push('too_predictable');

  if (context.email) {
    const local = context.email.split('@')[0]?.toLowerCase();
    if (local && local.length >= 3 && normalised.includes(local)) problems.push('contains_email');
  }

  // Variety, but only two of four classes: enough to exclude "aaaaaaaaaaaa"
  // without pushing people towards P@ssw0rd!.
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;
  if (value.length < 20 && classes < 2) problems.push('too_simple');

  return { ok: problems.length === 0, problems };
}

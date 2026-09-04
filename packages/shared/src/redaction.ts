/**
 * Secret redaction.
 *
 * docs/risks.md R-02: passwords reach logs far more easily than people expect —
 * through connection URLs, error messages, exception `cause` chains and library
 * internals we do not control. Two independent defences are applied here:
 *
 *   1. Key-based redaction, for values we can identify by the name they are
 *      stored under. Cheap, and catches structured logging.
 *   2. Value-based redaction, for known secret values wherever they appear,
 *      including inside free text we did not construct. This is the one that
 *      catches a third-party library logging a DSN.
 *
 * Neither is sufficient alone, which is why both run.
 */

export const REDACTED = '[redacted]';

/** Object keys whose values are replaced wholesale, matched case-insensitively. */
export const SECRET_KEY_PATTERNS: readonly RegExp[] = [
  // Unanchored on purpose. Anchoring to the end missed `passwordHash`, and a
  // database error carrying the row it failed to write embeds exactly that —
  // verified: an Argon2 hash reached the log untouched. Over-redacting a
  // `passwordUpdatedAt` timestamp is a price worth paying for that.
  /pass(word|wd)/i,
  /^secret/i,
  /secret$/i,
  /token$/i,
  /^authorization$/i,
  /^cookie$/i,
  /^set-cookie$/i,
  /api[-_]?key/i,
  /private[-_]?key/i,
  /^credential/i,
  /encryption[-_]?key/i,
  /^jwt/i,
  /csrf/i,
  /ticket$/i,
  /seed$/i,
  /recovery[-_]?code/i,
];

const isSecretKey = (key: string): boolean => SECRET_KEY_PATTERNS.some((re) => re.test(key));

/** Masks credentials embedded in URLs: postgres://user:pw@host -> postgres://user:[redacted]@host */
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(@)/gi;

export interface Redactor {
  /** Redact a free-text string. */
  text(value: string): string;
  /** Deep-redact an arbitrary value, by key and by known secret values. */
  value<T>(value: T): T;
  /** Register a secret value discovered at runtime, e.g. a generated password. */
  remember(secret: string): void;
  /** Forget a secret, e.g. once a rotation has completed and it is superseded. */
  forget(secret: string): void;
}

/**
 * Values shorter than this are not value-redacted: masking every occurrence of a
 * short string would mangle unrelated output without meaningfully protecting a
 * secret that weak.
 */
const MIN_TRACKED_SECRET_LENGTH = 8;

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function createRedactor(initialSecrets: readonly string[] = []): Redactor {
  const secrets = new Set<string>();

  const remember = (secret: string): void => {
    if (typeof secret === 'string' && secret.length >= MIN_TRACKED_SECRET_LENGTH) {
      secrets.add(secret);
    }
  };

  for (const s of initialSecrets) remember(s);

  const text = (value: string): string => {
    let out = value.replace(URL_CREDENTIALS, `$1${REDACTED}$3`);
    if (secrets.size > 0) {
      for (const secret of secrets) {
        out = out.replace(new RegExp(escapeRegExp(secret), 'g'), REDACTED);
      }
    }
    return out;
  };

  const walk = (value: unknown, seen: WeakSet<object>, depth: number): unknown => {
    if (depth > 12) return '[depth-limit]';
    if (value === null || value === undefined) return value;

    if (typeof value === 'string') return text(value);
    if (typeof value !== 'object') return value;

    if (seen.has(value as object)) return '[circular]';
    seen.add(value as object);

    if (Array.isArray(value)) return value.map((v) => walk(v, seen, depth + 1));

    if (value instanceof Error) {
      return {
        name: value.name,
        message: text(value.message),
        stack: value.stack ? text(value.stack) : undefined,
        cause: value.cause ? walk(value.cause, seen, depth + 1) : undefined,
      };
    }

    if (value instanceof Date) return value;
    if (value instanceof Map) return '[map]';
    if (value instanceof Set) return '[set]';
    if (Buffer.isBuffer(value)) return `[buffer ${value.length}B]`;

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKey(k) ? REDACTED : walk(v, seen, depth + 1);
    }
    return out;
  };

  return {
    text,
    value: <T>(v: T): T => walk(v, new WeakSet(), 0) as T,
    remember,
    forget: (secret: string) => {
      secrets.delete(secret);
    },
  };
}

/** Process-wide redactor. Configured at startup with values from the environment. */
export const rootRedactor: Redactor = createRedactor();

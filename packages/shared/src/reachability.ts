/**
 * Why a cluster could not be read, as one word the interface can translate.
 *
 * "192.168.15.101 is unreachable" was the whole story an operator got, while
 * the worker's log knew it was "connected, then no answer for 20 seconds" on one
 * node and "connection refused on 8006" on the other. Those are different
 * problems with different places to look — a hung `pveproxy` against a firewall
 * against a node still booting — and the difference was thrown away between the
 * socket and the screen.
 *
 * So the transport names the reason when it gives up, and writes it into its
 * message as a bracketed token. The message is what survives: the worker's
 * error crosses BullMQ to the API as text, and the cluster keeps it as its
 * `lastErrorDetail`. {@link unreachableReasonOf} reads the token back out. The
 * token is English and fixed; the sentence an operator reads is translated
 * from it.
 */

export const UNREACHABLE_REASONS = [
  /** No connection within the timeout: a firewall dropping packets, or a node that is off. */
  'connect_timeout',
  /** Connected and shook hands, then no answer within the timeout: the API itself is stuck. */
  'no_answer',
  /** Nothing listens on the port. */
  'refused',
  /** No route to the address from the Velnox server. */
  'no_route',
  /** The name did not resolve. */
  'dns',
  /** The connection was cut part-way. */
  'reset',
  /** The TLS handshake failed. */
  'tls',
  /** Velnox stopped waiting itself — a job cancelled or shut down. */
  'cancelled',
  'other',
] as const;

export type UnreachableReason = (typeof UNREACHABLE_REASONS)[number];

const BY_CODE: Record<string, UnreachableReason> = {
  ECONNREFUSED: 'refused',
  EHOSTUNREACH: 'no_route',
  ENETUNREACH: 'no_route',
  EHOSTDOWN: 'no_route',
  ENETDOWN: 'no_route',
  EADDRNOTAVAIL: 'no_route',
  ENOTFOUND: 'dns',
  EAI_AGAIN: 'dns',
  EAI_FAIL: 'dns',
  EAI_NONAME: 'dns',
  ECONNRESET: 'reset',
  ECONNABORTED: 'reset',
  EPIPE: 'reset',
  ETIMEDOUT: 'connect_timeout',
  EPROTO: 'tls',
};

/** The reason for a socket-level error, from its `code` and, failing that, its message. */
export function unreachableReasonFrom(error: unknown): UnreachableReason {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : '';
  const message = error instanceof Error ? error.message : String(error ?? '');

  if (code in BY_CODE) return BY_CODE[code] as UnreachableReason;
  if (code.startsWith('ERR_SSL_') || code.startsWith('ERR_TLS_')) return 'tls';
  if (/socket hang up/i.test(message)) return 'reset';
  if (/\b(ssl|tls)\b|handshake/i.test(message)) return 'tls';
  return 'other';
}

const TOKEN = /Could not reach \S+ \[([a-z_]+)\]/;

/** The bracketed token the transport writes, e.g. `[no_answer]`. */
export const unreachableToken = (reason: UnreachableReason): string => `[${reason}]`;

/**
 * The reason a stored message names, or null when it names none — a message
 * from before 0.7.19, or one that is not about reaching a host at all.
 */
export function unreachableReasonOf(detail: string | null | undefined): UnreachableReason | null {
  const match = detail ? TOKEN.exec(detail) : null;
  const reason = match?.[1];
  return reason && (UNREACHABLE_REASONS as readonly string[]).includes(reason)
    ? (reason as UnreachableReason)
    : null;
}

/**
 * Every reason a cluster can be FAILED for, as one word.
 *
 * The connection reasons above, plus the three that are answers rather than
 * silences: a certificate that is not the pinned one, credentials refused, and
 * something on the port that is not Proxmox.
 */
export type ClusterFailureReason = UnreachableReason | 'fingerprint' | 'auth' | 'not_proxmox';

export function clusterFailureReason(
  code: string | null | undefined,
  detail: string | null | undefined,
): ClusterFailureReason {
  switch (code) {
    case 'node.fingerprint_mismatch':
      return 'fingerprint';
    case 'cluster.auth_failed':
      return 'auth';
    case 'cluster.not_proxmox':
      return 'not_proxmox';
    default:
      return unreachableReasonOf(detail) ?? 'other';
  }
}

import { Agent, request as httpsRequest, type RequestOptions } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { fingerprintsMatch, normaliseFingerprint, type Fingerprint } from '@velnox/shared';

/**
 * The HTTPS transport, with certificate pinning.
 *
 * Built on `node:https` rather than `fetch`, for one reason: pinning needs the
 * peer certificate, and `fetch` does not expose the socket. Everything else
 * about this file would be shorter with `fetch`.
 *
 * How the pin is enforced matters, and getting it wrong is quiet. The check
 * happens before the request line — and therefore the API token — is written to
 * the socket. A pin verified after the response has arrived is not a pin; it is
 * a report that you have already sent your credentials to the wrong host.
 *
 * ## Connection reuse is the trap
 *
 * The first version of this listened for `secureConnect` and checked the
 * fingerprint there. That is correct exactly once per socket. Node's global
 * HTTPS agent keeps connections alive by default, so the *second* request
 * reuses the socket, `secureConnect` never fires again, and the pin is silently
 * never checked. A cluster added with a deliberately wrong fingerprint was
 * accepted, connected and fully discovered — found by `verify-proxmox.sh`
 * against a fixture, and invisible to every unit test, because the bug is in
 * the socket lifecycle rather than in the comparison.
 *
 * So a verified socket is *marked*, and every request checks the mark rather
 * than assuming a handshake it did not see. Sockets are pooled per client — one
 * agent per host and pin — so a marked socket can only ever have been verified
 * against the same fingerprint.
 */

export type VerifyMode =
  /** Trust the pinned fingerprint, and nothing else. The normal mode for PVE. */
  | 'pinned'
  /** Ordinary certificate-authority verification. For a node behind a real certificate. */
  | 'system'
  /**
   * No verification at all — and therefore **no credential may be sent**.
   *
   * Exactly one caller: `inspectCertificate`, the first half of adding a
   * cluster. An operator cannot confirm a fingerprint they have not been shown,
   * and showing it requires connecting to a host that is by definition not yet
   * trusted. What makes this safe is not the connection, it is what travels over
   * it: nothing. The handshake completes, the certificate is read, and the
   * request carries no token, no ticket and no cookie.
   */
  | 'inspect';

export interface TlsPolicy {
  mode: VerifyMode;
  /** Required when mode is `pinned`. */
  fingerprint?: Fingerprint;
  /** Extra CAs, for `system` mode behind a private authority. */
  ca?: string | string[];
}

export interface PeerCertificate {
  fingerprint: Fingerprint;
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  /** Whether Node's own chain verification would have accepted it. */
  trustedByCa: boolean;
}

export class FingerprintMismatchError extends Error {
  constructor(
    readonly expected: Fingerprint,
    readonly actual: Fingerprint,
    readonly host: string,
  ) {
    super(
      `Certificate fingerprint mismatch for ${host}. Expected ${expected}, got ${actual}. ` +
        'The connection was closed before anything was sent.',
    );
    this.name = 'FingerprintMismatchError';
  }
}

export class ProxmoxHttpError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly body: string,
    readonly path: string,
  ) {
    super(`Proxmox answered ${status} ${statusText} for ${path}`);
    this.name = 'ProxmoxHttpError';
  }
}

export class ProxmoxUnreachableError extends Error {
  constructor(
    readonly host: string,
    cause: unknown,
  ) {
    super(`Could not reach ${host}`, { cause });
    this.name = 'ProxmoxUnreachableError';
  }
}

export interface TransportOptions {
  host: string;
  port: number;
  tls: TlsPolicy;
  /** Per-attempt, not for the whole call including retries. */
  timeoutMs?: number;
  /**
   * The connection pool to use, or `false` for a fresh connection every time.
   *
   * Defaults to `false`. Pooling is opt-in because a pool shared between hosts
   * would hand back a socket verified against somebody else's certificate —
   * which is how the pin was defeated the first time. {@link createAgent} builds
   * one that is safe to share, and only within a single client.
   */
  agent?: Agent | false;
}

export interface RawResponse {
  status: number;
  statusText: string;
  body: string;
  headers: Record<string, string | string[] | undefined>;
  certificate: PeerCertificate | null;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Set on a socket once its certificate has been checked against a fingerprint.
 *
 * The value is the fingerprint it was checked against, not `true`: a socket
 * verified for one pin says nothing about another, and storing which one makes
 * that impossible to get wrong even if a pool is later shared.
 */
const VERIFIED_FOR = Symbol.for('velnox.pinnedFingerprint');

type MarkedSocket = TLSSocket & { [VERIFIED_FOR]?: string };

/**
 * A connection pool for one host and one pin.
 *
 * Keep-alive is worth having: a discovery run against a fifteen-node cluster is
 * forty-odd requests, and a TLS handshake each time is most of its wall clock.
 * What makes it safe is that the pool belongs to one client — never the global
 * agent, which is shared with every other host in the process.
 *
 * ## `maxCachedSessions: 0`, and why pinning requires it
 *
 * Node caches TLS sessions per agent and resumes them on new connections. A
 * resumed session skips the certificate exchange — the server has no reason to
 * send again what the client already agreed to — so `getPeerCertificate()`
 * returns an empty object, and there is nothing to compare a fingerprint
 * against.
 *
 * That is not a theory. Discovery opens six requests per node at once; the first
 * reused an open connection and worked, and the other five resumed sessions and
 * failed with "completed a TLS handshake with no certificate" — which is the
 * *correct* failure direction, and still meant five of six calls per node came
 * back empty. Found by `verify-proxmox.sh`; invisible to a unit test, because it
 * is a property of a real TLS stack talking to a real server.
 *
 * So sessions are not cached. Every new connection does a full handshake and
 * presents its certificate, which is the price of being able to check it. Open
 * connections are still reused, which is where most of the saving was anyway.
 */
export const createAgent = (): Agent =>
  new Agent({ keepAlive: true, maxSockets: 8, maxCachedSessions: 0, timeout: 30_000 });

function describeCertificate(socket: TLSSocket): PeerCertificate | null {
  const certificate = socket.getPeerCertificate(false);
  if (!certificate || Object.keys(certificate).length === 0) return null;

  const flatten = (value: Record<string, unknown> | undefined): string =>
    value
      ? Object.entries(value)
          .map(([key, entry]) => `${key}=${String(entry)}`)
          .join(', ')
      : '';

  return {
    fingerprint: normaliseFingerprint(certificate.fingerprint256),
    subject: flatten(certificate.subject as unknown as Record<string, unknown>),
    issuer: flatten(certificate.issuer as unknown as Record<string, unknown>),
    validFrom: certificate.valid_from,
    validTo: certificate.valid_to,
    trustedByCa: socket.authorized,
  };
}

/**
 * One HTTPS request. No retries — that is `withRetries` below, so the retry
 * policy is visible at the call site rather than hidden in the transport.
 */
export function rawRequest(
  options: TransportOptions,
  init: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const pinned = options.tls.mode === 'pinned';
    const verified = options.tls.mode === 'system';

    if (pinned && !options.tls.fingerprint) {
      reject(new Error('Pinned verification was requested without a fingerprint to pin to.'));
      return;
    }

    const requestOptions: RequestOptions = {
      host: options.host,
      port: options.port,
      method: init.method,
      path: init.path,
      headers: { accept: 'application/json', ...init.headers },
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      /*
       * The one place in Velnox where chain verification is off, and the only
       * one there will ever be.
       *
       * A Proxmox node presents the certificate its own installer generated. It
       * is not in any trust store and cannot be — so the choice is between
       * pinning a fingerprint an operator confirmed out of band, and having no
       * verification at all. Pinning is strictly stronger than CA verification
       * here: it identifies one specific certificate rather than anything a
       * trusted authority happens to have signed.
       *
       * It is enforced below on `secureConnect`, before a single byte of the
       * request is written. `system` mode leaves this on and is used when the
       * node genuinely has a publicly trusted certificate.
       */
      // eslint-disable-next-line no-restricted-syntax
      rejectUnauthorized: verified,
      ...(options.tls.ca ? { ca: options.tls.ca } : {}),
      /*
       * `false` unless a client supplies its own pool. Never Node's global
       * agent: it keeps connections alive across every host in the process, so
       * a request to a pinned host could be handed a socket opened for another
       * one. That is not a hypothetical — it is how the pin was first defeated.
       */
      agent: options.agent ?? false,
    };

    const request = httpsRequest(requestOptions);

    let certificate: PeerCertificate | null = null;
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      request.destroy();
      reject(error);
    };

    request.on('socket', (rawSocket) => {
      const socket = rawSocket as MarkedSocket;

      const inspect = (): void => {
        certificate = describeCertificate(socket);
        if (!pinned) return;

        const expected = normaliseFingerprint(options.tls.fingerprint as string);

        if (!certificate) {
          fail(new Error(`${options.host} completed a TLS handshake with no certificate.`));
          return;
        }

        if (!fingerprintsMatch(certificate.fingerprint, expected)) {
          // Destroying here is the whole point: the request line and headers,
          // which carry the API token, have not been written yet.
          fail(new FingerprintMismatchError(expected, certificate.fingerprint, options.host));
          return;
        }

        socket[VERIFIED_FOR] = expected;
      };

      /*
       * A socket handed back by a pool has already completed its handshake, so
       * `secureConnect` will never fire on it again. Checking the mark rather
       * than waiting for an event is what makes reuse safe — and reading the
       * certificate here is also what keeps `certificate` populated on a reused
       * connection, which the probe depends on.
       */
      let alreadyShookHands = false;
      try {
        // A socket mid-handshake answers with an empty object; a completed one
        // answers with the certificate. A plain socket has no such method at
        // all, which is what the catch is for.
        alreadyShookHands = Object.keys(socket.getPeerCertificate(false) ?? {}).length > 0;
      } catch {
        alreadyShookHands = false;
      }

      if (alreadyShookHands) {
        inspect();
        return;
      }

      socket.once('secureConnect', inspect);
    });

    request.on('timeout', () => {
      fail(new ProxmoxUnreachableError(options.host, new Error('Timed out')));
    });

    request.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(
        error instanceof FingerprintMismatchError
          ? error
          : new ProxmoxUnreachableError(options.host, error),
      );
    });

    init.signal?.addEventListener(
      'abort',
      () => fail(new ProxmoxUnreachableError(options.host, new Error('Cancelled'))),
      { once: true },
    );

    request.on('response', (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({
          status: response.statusCode ?? 0,
          statusText: response.statusMessage ?? '',
          body: Buffer.concat(chunks).toString('utf8'),
          headers: response.headers,
          certificate,
        });
      });
    });

    if (init.body !== undefined) request.write(init.body);
    request.end();
  });
}

/**
 * Look at a host's certificate without authenticating to it.
 *
 * This is the first half of adding a cluster: an operator needs to see the
 * fingerprint before deciding to trust it, and showing it to them requires
 * connecting to a host that is by definition not yet trusted. So this sends no
 * credential — it completes the handshake, reads the certificate, and asks for
 * the one endpoint Proxmox answers anonymously.
 *
 * A 401 here is a success: it means something spoke the Proxmox API.
 */
export async function inspectCertificate(options: {
  host: string;
  port: number;
  timeoutMs?: number;
}): Promise<{ certificate: PeerCertificate; respondedAsProxmox: boolean }> {
  const response = await rawRequest(
    {
      host: options.host,
      port: options.port,
      tls: { mode: 'inspect' },
      timeoutMs: options.timeoutMs,
    },
    // No `authorization` header, no cookie. That is what makes an unverified
    // connection acceptable here and nowhere else.
    { method: 'GET', path: '/api2/json/version' },
  );

  if (!response.certificate) {
    throw new Error(`${options.host} completed a TLS handshake with no certificate.`);
  }

  return {
    certificate: response.certificate,
    // 401 is the expected answer to an unauthenticated /version, and it is the
    // strongest signal available that this is a Proxmox API and not a web
    // server that happens to answer on 8006.
    respondedAsProxmox: response.status === 401 || response.status === 200,
  };
}

/** Status codes worth trying again. A 4xx is an answer; repeating it wastes time. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export interface RetryPolicy {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 3, baseDelayMs: 400, maxDelayMs: 4_000 };

export const isRetryable = (error: unknown): boolean => {
  // A mismatched fingerprint is a decision, not a hiccup. Retrying it would turn
  // "this host is not who it claims to be" into three attempts at the same
  // wrong host.
  if (error instanceof FingerprintMismatchError) return false;
  if (error instanceof ProxmoxHttpError) return RETRYABLE_STATUS.has(error.status);
  return error instanceof ProxmoxUnreachableError;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry with exponential backoff and full jitter.
 *
 * Jitter because a cluster of fifteen nodes whose discovery all failed at once
 * would otherwise retry in lockstep, which is how a degraded cluster becomes an
 * unreachable one.
 */
export async function withRetries<T>(
  operation: () => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY,
  onRetry?: (attempt: number, error: unknown) => void,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === policy.attempts || !isRetryable(error)) throw error;

      onRetry?.(attempt, error);
      const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
      await sleep(Math.random() * ceiling);
    }
  }

  throw lastError;
}

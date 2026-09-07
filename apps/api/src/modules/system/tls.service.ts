import { connect, type PeerCertificate } from 'node:tls';
import { Inject, Injectable } from '@nestjs/common';
import type { ApiConfig } from '@velnox/config';
import type { TlsMode, TlsStatusResponse } from '@velnox/shared';
import { API_CONFIG } from '../../config/config.module';

/**
 * What certificate is Velnox actually serving?
 *
 * Deliberately answered by opening a TLS connection to the proxy and reading the
 * certificate it presents, rather than by reading the configuration or a file.
 * Those say what *should* be served. The common failure after changing a
 * certificate is that the new one was written and the proxy never picked it up,
 * and a screen sourced from the configuration reports success for exactly that
 * case.
 *
 * The API holds no TLS material and cannot change any of this. `scripts/tls.sh`
 * on the host does, which keeps writing private keys and restarting the proxy
 * out of an HTTP endpoint.
 */

/** Long enough for a handshake on a loopback network; short enough not to hang a page. */
const HANDSHAKE_TIMEOUT_MS = 4000;

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class TlsService {
  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  /** `internal`, `certificate`, or an ACME account address meaning Let's Encrypt. */
  private mode(): TlsMode {
    const value = this.config.VELNOX_TLS.trim();
    if (value === '' || value === 'internal') return 'internal';
    if (value === 'certificate') return 'certificate';
    return 'acme';
  }

  async status(): Promise<TlsStatusResponse> {
    const mode = this.mode();
    const siteAddress = hostOf(this.config.APP_URL);

    const base = {
      mode,
      siteAddress,
      /** Only for ACME, and only to whoever can already change it. */
      acmeAccount: mode === 'acme' ? this.config.VELNOX_TLS.trim() : null,
    };

    let certificate: PeerCertificate | null;
    try {
      certificate = await this.peerCertificate(siteAddress);
    } catch (error) {
      return {
        ...base,
        reachable: false,
        certificate: null,
        // A code, not a sentence: this is rendered in the reader's language.
        problem: { code: 'tls.handshake_failed', params: { detail: shortReason(error) } },
      };
    }

    if (!certificate || Object.keys(certificate).length === 0) {
      return {
        ...base,
        reachable: true,
        certificate: null,
        problem: { code: 'tls.no_certificate' },
      };
    }

    const expiresAt = new Date(certificate.valid_to);
    const validExpiry = !Number.isNaN(expiresAt.getTime());
    const daysRemaining = validExpiry
      ? Math.floor((expiresAt.getTime() - Date.now()) / DAY_MS)
      : null;

    return {
      ...base,
      reachable: true,
      certificate: {
        subject: nameOf(certificate.subject),
        issuer: nameOf(certificate.issuer),
        // The names a browser will accept it for. `subjectaltname` arrives as
        // "DNS:a, DNS:b"; the prefixes are dropped so the frontend renders
        // hostnames rather than an OpenSSL field.
        names: namesOf(certificate),
        notBefore: isoOrNull(certificate.valid_from),
        notAfter: validExpiry ? expiresAt.toISOString() : null,
        daysRemaining,
        // Caddy's own CA names itself. Worth surfacing, because "why does my
        // browser warn" is the single most asked question about a new install.
        selfSigned: nameOf(certificate.issuer) === nameOf(certificate.subject),
        fingerprintSha256: certificate.fingerprint256 || null,
      },
      problem: null,
    };
  }

  /**
   * The certificate the proxy presents for this installation's own address.
   *
   * `servername` is the site address rather than the host connected to. Caddy
   * chooses its certificate by SNI, so asking with the wrong name would report
   * on a certificate no browser ever receives.
   *
   * ## Why verification is off here, and why that is not the thing the rule bans
   *
   * `eslint.config.mjs` forbids `rejectUnauthorized: false` outright, and the
   * reason is sound: Velnox connects out to Proxmox, vCenter and Hyper-V, where
   * accepting any certificate hands infrastructure credentials to whoever is in
   * the middle. Those connections pin a fingerprint or use a supplied CA bundle,
   * and this is the only exception in the codebase.
   *
   * This connection is a different act. It goes to our own reverse proxy over an
   * internal Docker network, carries nothing — no request is written — and
   * treats nothing it receives as trusted input: the certificate is read,
   * copied into a view model, and the socket is destroyed. Verification is off
   * because a self-signed certificate is a *supported configuration* and the
   * single most common one, so verifying would leave the default installation
   * unable to report on itself. That was measured rather than assumed: Node 22
   * exposes no certificate at all after a rejected handshake — neither
   * `err.cert` nor `getPeerCertificate()` — so there is no way to inspect a
   * self-signed certificate while verifying it.
   *
   * The alternative was reporting from configuration and files instead, which
   * would answer a different and weaker question: what Velnox *believes* it
   * serves. The failure this page exists to catch is a certificate that was
   * installed and never picked up, and that is exactly the case a
   * configuration-sourced answer reports as fine.
   */
  private peerCertificate(siteAddress: string): Promise<PeerCertificate | null> {
    return new Promise((resolve, reject) => {
      const socket = connect({
        host: this.config.VELNOX_PROXY_HOST,
        port: 443,
        servername: siteAddress,
        // Reading our own proxy's certificate in order to display it: nothing
        // is sent, nothing received is trusted. The ban this suppresses is
        // about outbound connections to managed infrastructure, which pin a
        // fingerprint. See the block comment above for the full reasoning.
        // eslint-disable-next-line no-restricted-syntax
        rejectUnauthorized: false,
        timeout: HANDSHAKE_TIMEOUT_MS,
      });

      const finish = (fn: () => void) => {
        socket.removeAllListeners();
        socket.destroy();
        fn();
      };

      socket.once('secureConnect', () => {
        const peer = socket.getPeerCertificate(false);
        finish(() => resolve(peer));
      });
      socket.once('timeout', () => finish(() => reject(new Error('timeout'))));
      socket.once('error', (error) => finish(() => reject(error)));
    });
  }
}

/** The host part of a URL, without the port: what SNI carries. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'localhost';
  }
}

function nameOf(field: PeerCertificate['subject'] | PeerCertificate['issuer']): string {
  if (!field || typeof field !== 'object') return '';
  const record = field as unknown as Record<string, string | string[]>;
  const cn = record.CN ?? record.O ?? '';
  return Array.isArray(cn) ? (cn[0] ?? '') : cn;
}

function namesOf(certificate: PeerCertificate): string[] {
  const raw = certificate.subjectaltname;
  if (!raw) {
    const cn = nameOf(certificate.subject);
    return cn ? [cn] : [];
  }
  return raw
    .split(',')
    .map((entry) => entry.trim().replace(/^(DNS|IP Address|URI|email):/i, ''))
    .filter((entry) => entry.length > 0);
}

function isoOrNull(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * A short, safe reason for a failed handshake.
 *
 * Node's error codes are stable and say something useful; the message can carry
 * a path or an address, so only the code travels.
 */
function shortReason(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  if (error instanceof Error && error.message === 'timeout') return 'ETIMEDOUT';
  return 'UNKNOWN';
}

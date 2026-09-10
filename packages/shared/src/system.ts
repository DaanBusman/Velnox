/** Contracts for the system endpoints. Shared by the API, the worker and the web app. */

export const LOCALES = ['en', 'nl'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';
export const isLocale = (v: unknown): v is Locale =>
  typeof v === 'string' && (LOCALES as readonly string[]).includes(v);

export const LOCALE_COOKIE = 'velnox_locale';
export const THEME_COOKIE = 'velnox_theme';

export type CheckStatus = 'ok' | 'degraded' | 'down';

/**
 * Translatable detail on a health check.
 *
 * A code plus parameters rather than a sentence: this text is rendered in the
 * status table, so an English sentence from the API would appear verbatim in the
 * middle of a Dutch page. ADR-019 — the API returns codes, the frontend renders
 * them.
 */
export interface CheckDetail {
  code: string;
  params?: Record<string, string | number>;
}

export interface DependencyCheck {
  name: string;
  status: CheckStatus;
  /** Round-trip time in milliseconds, when the check performed I/O. */
  latencyMs?: number;
  /** Translatable detail. Redacted; never contains credentials. */
  detail?: CheckDetail;
}

export interface HealthResponse {
  status: 'ok';
  uptimeSeconds: number;
}

export interface ReadinessResponse {
  status: CheckStatus;
  checks: DependencyCheck[];
  /** Migration names applied to the database but unknown to this build, and vice versa. */
  migrations: {
    status: CheckStatus;
    applied: number;
    expected: number;
    pending: string[];
    unknown: string[];
  };
}

/**
 * The attribution that must survive rebranding.
 *
 * Velnox is deliberately white-labellable: `system_settings.product_name` drives
 * the name in the interface, so an MSP can present it to its customers as its
 * own console. That is a legitimate use and it stays.
 *
 * This string is the boundary of it. AGPLv3 section 7(b) permits requiring that
 * specified legal notices and author attributions be preserved in the
 * Appropriate Legal Notices, and section 7(c) permits prohibiting
 * misrepresentation of origin. Velnox exercises both — see NOTICE — so a fork or
 * a rebranded deployment may carry any name it likes and must still show this.
 *
 * It is a constant rather than a setting for exactly that reason. Anything read
 * from the database could be edited by the operator whose obligation it is, and
 * a notice its subject can delete is not a notice.
 */
export const REQUIRED_ATTRIBUTION =
  'Powered by Velnox — Copyright © The Velnox Foundation. ' +
  'Free software under the GNU Affero General Public License, version 3 or later.';

/** The upstream name, for comparing against a rebranded `product`. */
export const UPSTREAM_PRODUCT_NAME = 'Velnox';

/**
 * AGPL section 13 source offer.
 *
 * Anyone interacting with a modified Velnox over a network must be able to
 * obtain the Corresponding Source of the build that is running. `commit` is
 * embedded at build time so the claim in `url` is verifiable rather than
 * asserted. See NOTICE and docs/architecture.md section 15.
 */
export interface SourceOfferResponse {
  product: string;
  version: string;
  commit: string;
  builtAt: string | null;
  license: 'AGPL-3.0-or-later';
  url: string;
  /** False when the operator has not changed VELNOX_SOURCE_URL from the upstream default. */
  modified: boolean;
  notice: string;
  /**
   * `REQUIRED_ATTRIBUTION`, verbatim.
   *
   * Sent rather than assumed by the frontend so that any client — the web app,
   * a machine reading the source offer, an operator's own interface built on
   * this API — receives the same notice from the same place.
   */
  attribution: string;
}

/** How TLS is configured. Not how it is working — that is the certificate below. */
export type TlsMode = 'internal' | 'acme' | 'certificate';

export interface TlsCertificateView {
  subject: string;
  issuer: string;
  /** Every name a browser will accept this certificate for. */
  names: string[];
  notBefore: string | null;
  notAfter: string | null;
  /** Negative once it has expired. Null when the date could not be read. */
  daysRemaining: number | null;
  selfSigned: boolean;
  fingerprintSha256: string | null;
}

/**
 * The certificate Velnox is actually serving, next to the mode configured for
 * it.
 *
 * Read by opening a TLS connection to the proxy rather than from a file: the
 * usual failure after changing a certificate is that the proxy never picked the
 * new one up, and a screen sourced from configuration reports success for
 * exactly that case. Requires `system.manage`.
 */
export interface TlsStatusResponse {
  mode: TlsMode;
  siteAddress: string;
  /** The ACME account address, in `acme` mode only. */
  acmeAccount: string | null;
  /** Whether the proxy completed a TLS handshake at all. */
  reachable: boolean;
  certificate: TlsCertificateView | null;
  /** Translatable detail when there is nothing to report. */
  problem: { code: string; params?: Record<string, string | number> } | null;
}

export interface SystemInfoResponse {
  product: string;
  version: string;
  environment: 'production' | 'development' | 'test';
  defaultLocale: Locale;
  supportedLocales: readonly Locale[];
  defaultTimezone: string;
  /** True once the setup wizard has created the first administrator (Phase 2). */
  initialized: boolean;
  features: Record<string, boolean>;
}

/** Phase 1 queue self-test. Replaced by the real job system in Phase 5. */
export interface PingJobAcceptedResponse {
  jobId: string;
  queuedAt: string;
}

export interface PingJobStatusResponse {
  jobId: string;
  state: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'paused' | 'unknown';
  queuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  attempts: number;
  result: { processedBy: string; durationMs: number; message: string } | null;
  failedReason: string | null;
}

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

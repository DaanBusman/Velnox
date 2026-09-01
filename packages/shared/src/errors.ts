/**
 * Error codes are the API's user-facing error surface.
 *
 * The API never returns a prose sentence as its primary error. It returns a
 * stable code plus typed parameters, and the frontend renders
 * `errors.<code>` from the active locale (docs/i18n.md). Beyond translation,
 * this makes errors assertable in tests, alertable in monitoring, and
 * documentable — none of which is true of a hand-written sentence.
 *
 * Codes are permanent. Changing the meaning of one means adding a new code.
 */
export const ERROR_CODES = {
  generic: 'generic',
  network: 'network',
  validation: 'validation',
  notFound: 'not_found',

  authInvalidCredentials: 'auth.invalid_credentials',
  authMfaRequired: 'auth.mfa_required',
  authMfaInvalid: 'auth.mfa_invalid',
  authSessionExpired: 'auth.session_expired',
  authRateLimited: 'auth.rate_limited',

  authzForbidden: 'authz.forbidden',
  authzTenantForbidden: 'authz.tenant_forbidden',

  setupAlreadyInitialized: 'setup.already_initialized',

  clusterUnreachable: 'cluster.unreachable',
  clusterQuorumAtRisk: 'cluster.quorum_at_risk',
  clusterAlreadyDegraded: 'cluster.already_degraded',

  nodeFingerprintMismatch: 'node.fingerprint_mismatch',
  nodeHostKeyMismatch: 'node.host_key_mismatch',

  cephNotHealthy: 'ceph.not_healthy',
  cephPgsNotClean: 'ceph.pgs_not_clean',
  cephVersionMismatch: 'ceph.version_mismatch',

  jobConcurrentRun: 'job.concurrent_run',
  jobWorkerLost: 'job.worker_lost',
  jobNotFound: 'job.not_found',

  upgradeBlockersPresent: 'upgrade.blockers_present',
  upgradeUnparsedOutput: 'upgrade.unparsed_output',

  credentialRotationVerifyFailed: 'credential.rotation_verify_failed',

  featureDisabled: 'feature.disabled',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Parameters interpolated into the localized message. Never secrets. */
export type ErrorParams = Record<string, string | number | boolean | null>;

export interface ApiErrorBody {
  error: {
    code: ErrorCode | string;
    /** English fallback. Diagnostic only — clients render from the code. */
    message: string;
    params?: ErrorParams;
    requestId?: string;
    /** Field-level detail for validation failures. */
    details?: { path: string; code: string; message: string }[];
  };
}

/**
 * An error carrying a translatable code. Thrown by services; converted to an
 * `ApiErrorBody` by the global exception filter.
 */
export class VelnoxError extends Error {
  readonly code: ErrorCode | string;
  readonly status: number;
  readonly params: ErrorParams | undefined;

  constructor(
    code: ErrorCode | string,
    options: { status?: number; message?: string; params?: ErrorParams; cause?: unknown } = {},
  ) {
    super(options.message ?? code, options.cause ? { cause: options.cause } : undefined);
    this.name = 'VelnoxError';
    this.code = code;
    this.status = options.status ?? 400;
    this.params = options.params;
  }
}

export const isVelnoxError = (e: unknown): e is VelnoxError => e instanceof VelnoxError;

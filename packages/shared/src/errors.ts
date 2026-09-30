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
  /** Refused because it would leave the installation with nobody who can administer it. */
  authzFoundingAdministrator: 'authz.founding_administrator',
  /** A second-factor reset was refused: your own account, or an MSP colleague's. */
  authzMfaResetForbidden: 'authz.mfa_reset_forbidden',
  /** An approval that needs a second person was attempted by the person who asked. */
  authzFourEyes: 'authz.four_eyes',

  setupAlreadyInitialized: 'setup.already_initialized',

  clusterUnreachable: 'cluster.unreachable',
  /** Something answered, but it is not a Proxmox API. */
  clusterNotProxmox: 'cluster.not_proxmox',
  /** The token or password was refused. */
  clusterAuthFailed: 'cluster.auth_failed',
  /** A cluster with this endpoint is already registered in this tenant. */
  clusterDuplicate: 'cluster.duplicate',
  clusterQuorumAtRisk: 'cluster.quorum_at_risk',
  clusterAlreadyDegraded: 'cluster.already_degraded',

  nodeFingerprintMismatch: 'node.fingerprint_mismatch',
  nodeHostKeyMismatch: 'node.host_key_mismatch',

  // SSH, used only to copy files off a node. A host key that differs from the
  // confirmed one is `node.host_key_mismatch` above.
  sshNotConfigured: 'ssh.not_configured',
  sshUnreachable: 'ssh.unreachable',
  sshAuthFailed: 'ssh.auth_failed',
  /** A host key was offered for confirmation that no longer matches what the node presents. */
  sshHostKeyChanged: 'ssh.host_key_changed',

  /** Would take the library past its configured size. */
  libraryFull: 'library.full',
  /** Would leave less free disk than the configured floor. */
  libraryDiskLow: 'library.disk_low',
  libraryInvalidFilename: 'library.invalid_filename',
  /** Not an .iso, or a disk image Proxmox can import. */
  libraryUnsupportedKind: 'library.unsupported_kind',
  libraryDuplicateFilename: 'library.duplicate_filename',
  libraryNotReady: 'library.not_ready',
  /** A job is using it right now. */
  libraryInUse: 'library.in_use',
  /** A chunk arrived for a different position than the upload is at. */
  libraryUploadOffset: 'library.upload_offset',
  /** More bytes than the upload declared. */
  libraryUploadTooLarge: 'library.upload_too_large',
  /** The address is not one Velnox will fetch from. */
  libraryUrlRefused: 'library.url_refused',
  libraryUrlFailed: 'library.url_failed',
  libraryUrlTooManyRedirects: 'library.url_too_many_redirects',
  /** Fewer or more bytes arrived than were promised. */
  librarySizeMismatch: 'library.size_mismatch',
  /** The bytes are not what the extension says: an .iso that is not an ISO image. */
  libraryWrongContent: 'library.wrong_content',
  libraryChecksumMismatch: 'library.checksum_mismatch',
  /** The storage does not accept this content type, or is not active on that node. */
  libraryStorageUnsuitable: 'library.storage_unsuitable',
  libraryStorageFull: 'library.storage_full',
  libraryAlreadyOnStorage: 'library.already_on_storage',
  libraryNotOnStorage: 'library.not_on_storage',
  /** The database says the file is there and the disk says it is not. */
  libraryFileMissing: 'library.file_missing',
  /** An upload nobody finished, removed after a day of silence. */
  libraryUploadAbandoned: 'library.upload_abandoned',

  cephNotHealthy: 'ceph.not_healthy',
  cephPgsNotClean: 'ceph.pgs_not_clean',
  cephVersionMismatch: 'ceph.version_mismatch',

  jobConcurrentRun: 'job.concurrent_run',
  jobWorkerLost: 'job.worker_lost',
  jobNotFound: 'job.not_found',
  /** Cancelling or deciding a job that has already reached a final state. */
  jobAlreadyFinished: 'job.already_finished',
  /** Retrying a job that succeeded, or has not finished. */
  jobNotRetryable: 'job.not_retryable',
  /**
   * A job of a kind that is started again from where it came from rather than
   * retried: a failed library fetch leaves a failed library item, and the way
   * back is adding the file again, not re-running a job pointed at it.
   */
  jobNotRetryableType: 'job.not_retryable_type',
  /** Approving or rejecting a job that is not waiting for it. */
  jobNotWaitingApproval: 'job.not_waiting_approval',
  /** The error a job carries once somebody rejected it at an approval gate. */
  jobRejected: 'job.rejected',

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

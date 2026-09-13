/*
 * Velnox — self-hosted MSP management for Proxmox VE.
 * Copyright (C) The Velnox Foundation.
 *
 * Free software under the GNU Affero General Public License, version 3 or
 * later, supplemented with additional terms permitted by section 7 of that
 * licence covering attribution, origin and trademarks. See LICENSE and NOTICE.
 */
/*
 * Certificate fingerprints live in @velnox/shared, not here.
 *
 * The API validates the fingerprint an operator pastes into the add-a-cluster
 * form, and the API must not depend on this package: ADR-009 keeps the Proxmox
 * adapter out of the image that serves HTTP. Fingerprint handling is a few
 * string functions with no network code, so it belongs on the other side of that
 * line — and is re-exported here so a caller that already has the client does
 * not need a second import.
 */
export {
  InvalidFingerprintError,
  fingerprintsMatch,
  isFingerprint,
  normaliseFingerprint,
  type Fingerprint,
} from '@velnox/shared';
export * from './transport';
export * from './client';
export * from './tasks';
export * from './discovery';

/**
 * Certificate fingerprints.
 *
 * A Proxmox cluster almost always presents a certificate its own installer
 * generated: self-signed, not in any trust store, and perfectly normal on a
 * management network. Refusing to talk to it would make Velnox useless; trusting
 * whatever turns up would make the connection meaningless.
 *
 * So the fingerprint is the trust anchor. An operator confirms it once, out of
 * band, and from then on it is what the connection is checked against —
 * certificate authority verification replaced by something an operator can
 * actually verify on the node with `pvenode cert info`.
 *
 * SHA-256 only. SHA-1 fingerprints are still printed by some tools and are not
 * accepted here: a fingerprint whose collision resistance is broken is a
 * fingerprint an attacker can aim at.
 */

/** `AA:BB:…` uppercase hex, 32 bytes. What `pvenode cert info` prints. */
export type Fingerprint = string;

const HEX_32_BYTES = /^[0-9a-f]{64}$/i;

export class InvalidFingerprintError extends Error {
  constructor(value: string) {
    super(
      `Not a SHA-256 certificate fingerprint: ${value.slice(0, 80)}. ` +
        'Expected 32 bytes as hex, with or without colons — the value `pvenode cert info` prints.',
    );
    this.name = 'InvalidFingerprintError';
  }
}

/**
 * Accept the shapes operators actually paste, and store exactly one of them.
 *
 * `pvenode cert info` prints colon-separated uppercase. Node's
 * `getPeerCertificate().fingerprint256` prints the same. A browser's certificate
 * viewer prints spaces on some platforms, and someone copying from a terminal
 * often brings a newline. All of those mean the same certificate, and a
 * comparison that says otherwise is a comparison that fails for the wrong reason.
 */
export function normaliseFingerprint(value: string): Fingerprint {
  const hex = value.replace(/[\s:-]/g, '');
  if (!HEX_32_BYTES.test(hex)) throw new InvalidFingerprintError(value);

  return (hex.toUpperCase().match(/.{2}/g) ?? []).join(':');
}

export function isFingerprint(value: unknown): value is Fingerprint {
  if (typeof value !== 'string') return false;
  try {
    normaliseFingerprint(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Constant-time comparison.
 *
 * A fingerprint is public, so a timing side channel here leaks nothing an
 * attacker could not read off the certificate itself. It is constant-time
 * anyway, because the habit is worth more than the reasoning: the next value
 * compared this way may not be public, and "this one was fine" is how the other
 * kind of bug arrives.
 */
export function fingerprintsMatch(a: string, b: string): boolean {
  let left: string;
  let right: string;
  try {
    left = normaliseFingerprint(a);
    right = normaliseFingerprint(b);
  } catch {
    return false;
  }

  if (left.length !== right.length) return false;

  let difference = 0;
  for (let i = 0; i < left.length; i += 1) {
    difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return difference === 0;
}

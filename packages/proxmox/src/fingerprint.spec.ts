import { describe, expect, it } from 'vitest';
import {
  InvalidFingerprintError,
  fingerprintsMatch,
  isFingerprint,
  normaliseFingerprint,
} from './fingerprint';

/**
 * The fingerprint is the trust anchor for every connection to a managed node,
 * so the only interesting question about it is what it refuses.
 */

const REAL =
  'C3:9A:81:2E:44:0B:7D:5F:A1:66:90:CE:2B:14:F8:D0:39:7C:52:AE:6B:11:C4:83:0F:D7:25:9A:68:B3:41:EC';

describe('normalising what an operator pasted', () => {
  it('accepts what pvenode cert info prints', () => {
    expect(normaliseFingerprint(REAL)).toBe(REAL);
  });

  it('accepts it lower case', () => {
    expect(normaliseFingerprint(REAL.toLowerCase())).toBe(REAL);
  });

  it('accepts it with no separators at all', () => {
    expect(normaliseFingerprint(REAL.replace(/:/g, ''))).toBe(REAL);
  });

  it('accepts spaces, which is what some certificate viewers print', () => {
    expect(normaliseFingerprint(REAL.replace(/:/g, ' '))).toBe(REAL);
  });

  it('accepts the newline that comes with a copy from a terminal', () => {
    expect(normaliseFingerprint(`  ${REAL}\n`)).toBe(REAL);
  });

  it('refuses a SHA-1 fingerprint', () => {
    // Still printed by older tools, and 20 bytes rather than 32. Accepting it
    // would mean pinning to a hash whose collision resistance is broken — a
    // fingerprint an attacker can aim at is not a trust anchor.
    const sha1 = 'DA:39:A3:EE:5E:6B:4B:0D:32:55:BF:EF:95:60:18:90:AF:D8:07:09';
    expect(() => normaliseFingerprint(sha1)).toThrow(InvalidFingerprintError);
  });

  it('refuses something that is nearly right', () => {
    expect(() => normaliseFingerprint(`${REAL}:00`)).toThrow(InvalidFingerprintError);
    expect(() => normaliseFingerprint(REAL.slice(0, -1))).toThrow(InvalidFingerprintError);
  });

  it('refuses a hostname pasted into the wrong field', () => {
    expect(isFingerprint('pve1.example.com')).toBe(false);
    expect(isFingerprint('')).toBe(false);
    expect(isFingerprint(null)).toBe(false);
  });
});

describe('comparison', () => {
  it('matches across formats, because they are the same certificate', () => {
    expect(fingerprintsMatch(REAL, REAL.toLowerCase().replace(/:/g, ''))).toBe(true);
  });

  it('does not match a different certificate', () => {
    const other = REAL.replace(/^C3/, 'C4');
    expect(fingerprintsMatch(REAL, other)).toBe(false);
  });

  it('returns false rather than throwing on rubbish', () => {
    // This is called on the TLS handshake path, where a throw would surface as
    // a connection error rather than as "that is not the host you pinned".
    expect(fingerprintsMatch(REAL, 'not a fingerprint')).toBe(false);
    expect(fingerprintsMatch('', '')).toBe(false);
  });
});

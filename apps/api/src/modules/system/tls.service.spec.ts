import { describe, expect, it } from 'vitest';
import { isRenewalOverdue } from './tls.service';

const HOUR_MS = 60 * 60 * 1000;
const issued = new Date('2026-11-21T15:49:30.000Z');
/** The lifetime measured on Caddy 2.11's internal issuer. */
const expires = new Date(issued.getTime() + 12 * HOUR_MS);
const hoursLeft = (hours: number) => expires.getTime() - hours * HOUR_MS;

describe('isRenewalOverdue', () => {
  it('stays quiet for a fresh internal certificate, which always has 0 whole days left', () => {
    expect(isRenewalOverdue('internal', issued, expires, hoursLeft(11))).toBe(false);
  });

  it('stays quiet during the normal renewal window', () => {
    expect(isRenewalOverdue('internal', issued, expires, hoursLeft(4))).toBe(false);
    expect(isRenewalOverdue('internal', issued, expires, hoursLeft(2))).toBe(false);
  });

  it('reports an internal certificate that should have been replaced', () => {
    expect(isRenewalOverdue('internal', issued, expires, hoursLeft(1.99))).toBe(true);
    expect(isRenewalOverdue('internal', issued, expires, hoursLeft(0))).toBe(true);
  });

  it('leaves an expired certificate to the expired notice', () => {
    expect(isRenewalOverdue('internal', issued, expires, hoursLeft(-0.01))).toBe(false);
  });

  it('applies only to certificates Caddy issues itself', () => {
    expect(isRenewalOverdue('acme', issued, expires, hoursLeft(1))).toBe(false);
    expect(isRenewalOverdue('certificate', issued, expires, hoursLeft(1))).toBe(false);
  });

  it('does not guess from an unreadable date', () => {
    expect(isRenewalOverdue('internal', new Date('nonsense'), expires, hoursLeft(1))).toBe(false);
  });
});

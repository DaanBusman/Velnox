import { describe, expect, it } from 'vitest';
import { isDue } from './scheduler';

/**
 * When a cluster is due for discovery.
 *
 * Small, and worth pinning because the edge is the one that decides whether a
 * newly added cluster ever gets read: "never discovered" has to mean "due now",
 * not "never due".
 */

const NOW = new Date('2026-09-13T12:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

describe('isDue', () => {
  it('is due immediately when it has never been discovered', () => {
    expect(isDue({ discoveryIntervalMinutes: 30, lastDiscoveryAt: null }, NOW)).toBe(true);
  });

  it('is not due before the interval has elapsed', () => {
    expect(isDue({ discoveryIntervalMinutes: 30, lastDiscoveryAt: minutesAgo(29) }, NOW)).toBe(
      false,
    );
  });

  it('is due exactly on the interval', () => {
    expect(isDue({ discoveryIntervalMinutes: 30, lastDiscoveryAt: minutesAgo(30) }, NOW)).toBe(
      true,
    );
  });

  it('is due once the interval has passed', () => {
    expect(isDue({ discoveryIntervalMinutes: 30, lastDiscoveryAt: minutesAgo(90) }, NOW)).toBe(
      true,
    );
  });

  it('is never due when the interval is zero', () => {
    // Zero is how scheduled discovery is turned off for one customer without
    // turning it off for everyone — including for a cluster that has never been
    // read, which is the case the "never discovered means due now" rule above
    // would otherwise catch.
    expect(isDue({ discoveryIntervalMinutes: 0, lastDiscoveryAt: null }, NOW)).toBe(false);
    expect(isDue({ discoveryIntervalMinutes: 0, lastDiscoveryAt: minutesAgo(600) }, NOW)).toBe(
      false,
    );
  });

  it('is never due for a negative interval, rather than being due constantly', () => {
    // Not reachable through the API, which validates the range. Asserted because
    // the arithmetic would otherwise make a negative interval mean "always", and
    // the failure would be a cluster hammered every minute.
    expect(isDue({ discoveryIntervalMinutes: -5, lastDiscoveryAt: minutesAgo(1) }, NOW)).toBe(
      false,
    );
  });
});

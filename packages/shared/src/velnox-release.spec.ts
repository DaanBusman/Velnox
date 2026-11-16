import { describe, expect, it } from 'vitest';
import {
  advisoriesFor,
  compareReleaseVersions,
  releaseManifestSchema,
  type ReleaseManifest,
} from './velnox-release';

const title = { en: 'A fix', nl: 'Een oplossing' };

describe('compareReleaseVersions', () => {
  it('orders by major, minor, patch as numbers, not text', () => {
    expect(compareReleaseVersions('0.7.10', '0.7.9')).toBeGreaterThan(0);
    expect(compareReleaseVersions('0.7.20', '0.8.0')).toBeLessThan(0);
    expect(compareReleaseVersions('1.0.0', '0.15.99')).toBeGreaterThan(0);
    expect(compareReleaseVersions('0.7.20', '0.7.20')).toBe(0);
  });

  it('puts a pre-release before its release', () => {
    expect(compareReleaseVersions('0.8.0-rc.1', '0.8.0')).toBeLessThan(0);
    expect(compareReleaseVersions('0.0.0-dev', '0.0.1')).toBeLessThan(0);
    expect(compareReleaseVersions('0.8.0-rc.1', '0.8.0-rc.2')).toBeLessThan(0);
  });
});

describe('advisoriesFor', () => {
  const manifest = (advisories: ReleaseManifest['advisories']): ReleaseManifest => ({
    version: '0.7.25',
    advisories,
  });

  it('names what the running version is affected by and the newest fixes', () => {
    const found = advisoriesFor(
      manifest([
        { id: 'VELNOX-1', severity: 'important', fixedIn: '0.7.22', title },
        { id: 'VELNOX-2', severity: 'critical', fixedIn: '0.7.21', title },
        { id: 'VELNOX-3', severity: 'critical', fixedIn: '0.7.20', title },
      ]),
      '0.7.20',
    );
    // Fixed in the running version: not affected. Critical first.
    expect(found.map((a) => a.id)).toEqual(['VELNOX-2', 'VELNOX-1']);
  });

  it('leaves out a problem introduced after the running version', () => {
    expect(
      advisoriesFor(
        manifest([{ id: 'VELNOX-4', severity: 'critical', fixedIn: '0.7.24', introducedIn: '0.7.22', title }]),
        '0.7.20',
      ),
    ).toEqual([]);
  });

  it('leaves out a fix the version on offer does not have yet', () => {
    expect(
      advisoriesFor(manifest([{ id: 'VELNOX-5', severity: 'critical', fixedIn: '0.7.30', title }]), '0.7.20'),
    ).toEqual([]);
  });
});

describe('releaseManifestSchema', () => {
  it('reads the file as the repository carries it', () => {
    expect(releaseManifestSchema.parse({ version: '0.7.21' })).toEqual({ version: '0.7.21', advisories: [] });
  });

  it('refuses a link that is not https, and a version that is not one', () => {
    expect(
      releaseManifestSchema.safeParse({
        version: '0.7.21',
        advisories: [{ id: 'VELNOX-6', severity: 'critical', fixedIn: '0.7.21', title, url: 'javascript:alert(1)' }],
      }).success,
    ).toBe(false);
    expect(releaseManifestSchema.safeParse({ version: 'latest' }).success).toBe(false);
  });
});

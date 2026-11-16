import { z } from 'zod';

/**
 * Is there a newer Velnox, and does it fix something critical? (0.7.21)
 *
 * The worker reads one small file, `release.json` at the root of the
 * repository's main branch: the newest version and the advisories — fixes an
 * operator should not sit on. Nothing is sent but the request for that file:
 * no version, no instance id, no count of anything. GitHub sees the address
 * the request comes from, as with any download.
 *
 * Whether an advisory concerns *this* installation is worked out here against
 * the running version, not when the file was read, so an installation that was
 * upgraded stops saying it is affected without waiting for the next check.
 */

/** The file the worker reads, unless VELNOX_UPDATE_MANIFEST_URL names another. */
export const UPDATE_MANIFEST_URL =
  'https://raw.githubusercontent.com/DaanBusman/Velnox/main/release.json';

/** How often the worker reads it while the check is on. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60_000;

/** The most the file may be. It is a few hundred bytes; this is a ceiling, not a size. */
export const UPDATE_MANIFEST_MAX_BYTES = 256 * 1024;

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const version = z.string().regex(VERSION, 'A version like 0.7.21');
const text = z.object({ en: z.string().min(1).max(300), nl: z.string().min(1).max(300) });

export const ADVISORY_SEVERITIES = ['critical', 'important'] as const;
export type AdvisorySeverity = (typeof ADVISORY_SEVERITIES)[number];

export const releaseAdvisorySchema = z.object({
  /** Stable, for linking and for telling two apart: VELNOX-2026-001. */
  id: z.string().regex(/^[A-Z][A-Z0-9-]{2,40}$/),
  severity: z.enum(ADVISORY_SEVERITIES),
  /** The first version with the fix. Older versions are affected. */
  fixedIn: version,
  /** The first version with the problem, when it did not always exist. */
  introducedIn: version.optional(),
  title: text,
  /** Where to read more. https only: it becomes a link in the interface. */
  url: z
    .string()
    .max(500)
    .regex(/^https:\/\/[^\s"'<>]+$/)
    .optional(),
});
export type ReleaseAdvisory = z.infer<typeof releaseAdvisorySchema>;

export const releaseManifestSchema = z.object({
  version,
  advisories: z.array(releaseAdvisorySchema).max(200).default([]),
});
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

/**
 * Compare two versions: negative when `a` is older, 0 when equal, positive when
 * newer. A pre-release (`0.8.0-rc.1`, `0.0.0-dev`) is older than its release;
 * two pre-releases of one version compare by their text.
 */
export function compareReleaseVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = '', pre = ''] = v.split('-', 2);
    const [x = 0, y = 0, z = 0] = core.split('.').map((part) => Number.parseInt(part, 10) || 0);
    return { parts: [x, y, z], pre };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = left.parts[i]! - right.parts[i]!;
    if (diff !== 0) return diff;
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre < right.pre ? -1 : 1;
}

/**
 * The advisories the running version is affected by and the newest version
 * fixes: fixed after it, not introduced after it, and fixed no later than the
 * version on offer. Most severe first, then newest first.
 */
export function advisoriesFor(manifest: ReleaseManifest, running: string): ReleaseAdvisory[] {
  return manifest.advisories
    .filter(
      (advisory) =>
        compareReleaseVersions(advisory.fixedIn, running) > 0 &&
        compareReleaseVersions(advisory.fixedIn, manifest.version) <= 0 &&
        (!advisory.introducedIn || compareReleaseVersions(advisory.introducedIn, running) <= 0),
    )
    .sort(
      (a, b) =>
        ADVISORY_SEVERITIES.indexOf(a.severity) - ADVISORY_SEVERITIES.indexOf(b.severity) ||
        compareReleaseVersions(b.fixedIn, a.fixedIn),
    );
}

/**
 * Why a check did not produce an answer. Codes, translated by the interface:
 * `network` the address could not be reached, `timeout` no answer in time,
 * `http` an answer other than 200, `too_large` more than the ceiling, `invalid`
 * not the file it should be.
 */
export const UPDATE_CHECK_ERRORS = ['network', 'timeout', 'http', 'too_large', 'invalid'] as const;
export type UpdateCheckError = (typeof UPDATE_CHECK_ERRORS)[number];

/** `GET /system/update`. */
export interface UpdateStatusResponse {
  /** Whether the worker checks. Off: nothing below is current. */
  enabled: boolean;
  running: string;
  /** The newest version the last good check found. Null before one. */
  latest: string | null;
  updateAvailable: boolean;
  /** At least one advisory below is critical. */
  critical: boolean;
  advisories: ReleaseAdvisory[];
  /** The last attempt, good or not. */
  checkedAt: string | null;
  /** The last attempt that produced an answer. */
  succeededAt: string | null;
  /** Why the last attempt did not, when it did not. */
  error: UpdateCheckError | null;
  /** HTTP status or similar, for the error: never a secret. */
  errorDetail: string | null;
  /** The address read, so an operator can see where it asks. */
  source: string;
}

import { withSystemScope, type Prisma, type VelnoxPrismaClient } from '@velnox/db';
import {
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_MANIFEST_MAX_BYTES,
  releaseManifestSchema,
  type ReleaseManifest,
  type UpdateCheckError,
} from '@velnox/shared';

/**
 * Read release.json and write down what it says (0.7.21).
 *
 * One GET, with nothing in it but the address: no version, no instance id, a
 * User-Agent that names the product and nothing else. The answer is validated
 * before anything is kept, so a page of HTML from a captive portal is "not the
 * file" rather than a version. A failed read keeps the last good answer and
 * records why this one failed — "could not ask" is never shown as "up to date".
 */

const TIMEOUT_MS = 20_000;
const USER_AGENT = 'Velnox update check';

export type CheckOutcome =
  | { ok: true; manifest: ReleaseManifest }
  | { ok: false; error: UpdateCheckError; detail: string };

/** Fetch and validate the file. Exported for tests: it touches no database. */
export async function readManifest(url: string, timeoutMs = TIMEOUT_MS): Promise<CheckOutcome> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { ok: false, error: 'timeout', detail: `No answer within ${timeoutMs / 1000} s` };
    }
    const cause = (error as { cause?: { code?: string; message?: string } } | null)?.cause;
    return { ok: false, error: 'network', detail: cause?.code ?? cause?.message ?? String(error) };
  }

  // An https address that was redirected to plain http is not trusted with
  // the answer. (The configured address is https; the tests use loopback http.)
  if (url.startsWith('https://') && response.url && !response.url.startsWith('https://')) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, error: 'invalid', detail: 'Redirected to plain http' };
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, error: 'http', detail: `HTTP ${response.status}` };
  }

  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > UPDATE_MANIFEST_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, error: 'too_large', detail: `More than ${UPDATE_MANIFEST_MAX_BYTES} bytes` };
      }
      chunks.push(value);
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return { ok: false, error: 'invalid', detail: 'Not JSON' };
  }
  const manifest = releaseManifestSchema.safeParse(parsed);
  if (!manifest.success) {
    const issue = manifest.error.issues[0];
    return {
      ok: false,
      error: 'invalid',
      detail: issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'Not a release file',
    };
  }
  return { ok: true, manifest: manifest.data };
}

/**
 * Check now and record the result. `force` checks even when the check is
 * switched off — never used by the timer, only by Check now, which an
 * administrator presses. Returns what was recorded.
 */
export async function runUpdateCheck(
  prisma: VelnoxPrismaClient,
  url: string,
  options: { force?: boolean } = {},
): Promise<{ checked: boolean; outcome?: CheckOutcome }> {
  return withSystemScope('the update check belongs to no request', async () => {
    const settings = await prisma.systemSettings.findUnique({
      where: { id: 1 },
      select: { updateCheckEnabled: true },
    });
    if (!settings || (!settings.updateCheckEnabled && !options.force)) return { checked: false };

    const outcome = await readManifest(url);
    const now = new Date();
    await prisma.systemSettings.update({
      where: { id: 1 },
      data: outcome.ok
        ? {
            updateManifest: outcome.manifest as unknown as Prisma.InputJsonValue,
            updateCheckedAt: now,
            updateSucceededAt: now,
            updateCheckError: null,
            updateCheckErrorDetail: null,
          }
        : {
            updateCheckedAt: now,
            updateCheckError: outcome.error,
            updateCheckErrorDetail: outcome.detail.slice(0, 300),
          },
    });
    return { checked: true, outcome };
  });
}

/**
 * The timer's question: is a check due? Every quarter of an hour while it is on,
 * judged from the last attempt in the database rather than from the worker's
 * start, so a worker that restarts ten times an hour still asks four times an
 * hour. A failed attempt waits the same quarter of an hour: an installation that
 * cannot reach GitHub does not keep trying.
 */
export async function updateCheckDue(prisma: VelnoxPrismaClient, now = Date.now()): Promise<boolean> {
  return withSystemScope('the update check belongs to no request', async () => {
    const settings = await prisma.systemSettings.findUnique({
      where: { id: 1 },
      select: { updateCheckEnabled: true, updateCheckedAt: true },
    });
    if (!settings?.updateCheckEnabled) return false;
    return !settings.updateCheckedAt || now - settings.updateCheckedAt.getTime() >= UPDATE_CHECK_INTERVAL_MS;
  });
}

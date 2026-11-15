import {
  ERROR_CODES,
  VIRTIO_WIN_FILENAME,
  VIRTIO_WIN_PATTERN,
  VIRTIO_WIN_URL,
} from '@velnox/shared';
import { StepError, type StepContext } from '../jobs/steps';
import { fetchIntoLibrary } from '../library/playbooks';
import type { LibraryServices } from '../library/services';

/**
 * "VirtIO ISO: Yes" (0.7.20): the library's VirtIO ISO, fetched into it first
 * when it has none.
 *
 * A template used to name the VirtIO ISO by its library filename, and a
 * library without one meant a template that could not be saved with the
 * drivers on. "Yes" uses whichever VirtIO ISO the library holds — the newest,
 * if there are several — and when there is none, the provisioning job fetches
 * the stable one from {@link VIRTIO_WIN_URL} into the library itself, then
 * carries on and attaches it. The next VM finds it there.
 *
 * Fetched inside the provisioning job, not by a job of its own: a job that
 * waited on another would hold one of the worker's slots while it waits, and
 * four VMs asked for at once would hold all four with the fetch queued behind
 * them. Two jobs that both find none do not both fetch: the library's unique
 * filename lets one create the item, and the other waits for that one.
 */

/** How often a job waiting for another job's fetch looks again. */
const WAIT_POLL_MS = 3_000;

/** The newest READY VirtIO ISO in the library, by filename, or null. */
export async function readyVirtioIso(prisma: LibraryServices['prisma']): Promise<string | null> {
  const items = await prisma.libraryItem.findMany({
    where: { kind: 'ISO', state: 'READY', filename: { startsWith: 'virtio-win', mode: 'insensitive' } },
    select: { filename: true, readyAt: true, createdAt: true },
  });
  const matching = items
    .filter((item) => VIRTIO_WIN_PATTERN.test(item.filename))
    .sort(
      (a, b) =>
        (b.readyAt ?? b.createdAt).getTime() - (a.readyAt ?? a.createdAt).getTime(),
    );
  return matching[0]?.filename ?? null;
}

/**
 * A VirtIO ISO in the library, READY: the one there, the one another job is
 * fetching, or one this job fetches now. Returns its filename.
 */
export async function ensureVirtioIso(
  services: LibraryServices,
  jobId: string,
  context: StepContext,
): Promise<string> {
  const { prisma } = services;

  for (;;) {
    const ready = await readyVirtioIso(prisma);
    if (ready) return ready;

    // Someone is already bringing one in: wait for it rather than fetch twice.
    const inFlight = await prisma.libraryItem.findFirst({
      where: {
        kind: 'ISO',
        state: { in: ['RECEIVING', 'VERIFYING'] },
        filename: { equals: VIRTIO_WIN_FILENAME, mode: 'insensitive' },
      },
      select: { id: true },
    });
    if (inFlight) {
      await waitFor(services, inFlight.id, context);
      continue;
    }

    let itemId: string;
    try {
      const item = await prisma.libraryItem.create({
        data: {
          kind: 'ISO',
          source: 'URL',
          state: 'RECEIVING',
          filename: VIRTIO_WIN_FILENAME,
          sourceUrl: VIRTIO_WIN_URL,
          jobId,
          createdByLabel: 'Autoconfig (VirtIO ISO: Yes)',
        },
        select: { id: true },
      });
      itemId = item.id;
    } catch (error) {
      // Another job created it between the look and the create: wait for that.
      if ((error as { code?: unknown } | null)?.code === 'P2002') continue;
      throw error;
    }

    await context.log(
      'STDOUT',
      `The library has no VirtIO ISO; fetching ${VIRTIO_WIN_FILENAME} from the Fedora project`,
    );
    try {
      return await fetchIntoLibrary(services, itemId, jobId, context);
    } catch (error) {
      if (error instanceof StepError || context.signal.aborted) throw error;
      throw new StepError(
        ERROR_CODES.autoconfigVirtioFetchFailed,
        `Fetching the VirtIO ISO failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** Wait for another job's fetch to end, reporting its progress as this step's. */
async function waitFor(services: LibraryServices, itemId: string, context: StepContext) {
  let logged = false;
  for (;;) {
    const item = await services.prisma.libraryItem.findUnique({
      where: { id: itemId },
      select: { state: true, receivedBytes: true, sizeBytes: true, filename: true },
    });
    if (!item || item.state === 'READY') return;
    if (item.state === 'FAILED') {
      throw new StepError(
        ERROR_CODES.autoconfigVirtioFetchFailed,
        `Another job's fetch of ${item.filename} failed`,
      );
    }
    if (!logged) {
      await context.log('STDOUT', `Waiting for ${item.filename}, which another job is fetching`);
      logged = true;
    }
    if (item.sizeBytes && item.sizeBytes > 0n) {
      await context.progress(Math.min(99, Number((item.receivedBytes * 100n) / item.sizeBytes)));
    }
    await context.sleep(WAIT_POLL_MS);
  }
}

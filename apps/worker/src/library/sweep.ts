import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { withSystemScope } from '@velnox/db';
import { ACTIVE_JOB_STATUSES, ERROR_CODES, displayUrl } from '@velnox/shared';
import type { LibraryServices } from './services';

/**
 * Keeping the library honest when no job is left to do it.
 *
 * A job's own cleanup handles cancellation and failure. It cannot handle the
 * worker dying — the cleanup dies with it — and nothing handles an upload a
 * browser started and never finished. This does, at startup and every quarter
 * of an hour:
 *
 * 1. **Items a dead job was writing** are failed with `job.worker_lost` and
 *    their partial bytes removed. Not retried, for the same reason a lost job
 *    is not.
 * 2. **Uploads silent for a day** are removed, bytes and row. A person who
 *    comes back after a day starts again; a library that keeps every abandoned
 *    half-upload fills up.
 * 3. **Files with no row** are removed. The row is the record; a file nothing
 *    points at can never be pushed, shown or deleted through Velnox.
 * 4. **READY rows with no file** are failed with `library.file_missing`, so the
 *    screen stops offering something that cannot be pushed.
 */

export const LIBRARY_SWEEP_INTERVAL_MS = 15 * 60_000;
export const ABANDONED_UPLOAD_MS = 24 * 60 * 60_000;

export interface SweepResult {
  lostTransfers: number;
  abandonedUploads: number;
  orphanFiles: number;
  missingFiles: number;
}

export async function sweepLibrary(
  services: LibraryServices,
  now = new Date(),
): Promise<SweepResult> {
  return withSystemScope('sweeping the library belongs to no request', async () => {
    const { prisma, paths } = services;
    const result: SweepResult = {
      lostTransfers: 0,
      abandonedUploads: 0,
      orphanFiles: 0,
      missingFiles: 0,
    };

    // --- 1. items whose job is no longer running -----------------------------
    const inFlight = await prisma.libraryItem.findMany({
      where: { state: { in: ['RECEIVING', 'VERIFYING'] }, jobId: { not: null } },
      select: { id: true, jobId: true, sourceUrl: true },
    });
    for (const item of inFlight) {
      const job = await prisma.job.findUnique({
        where: { id: item.jobId! },
        select: { status: true },
      });
      if (job && ACTIVE_JOB_STATUSES.has(job.status)) continue;
      await rm(paths.partial(item.id), { force: true });
      const updated = await prisma.libraryItem.updateMany({
        // Conditional: a job that has just finished and published the item
        // must not be failed after the fact.
        where: { id: item.id, state: { in: ['RECEIVING', 'VERIFYING'] }, jobId: item.jobId },
        data: {
          state: 'FAILED',
          jobId: null,
          sourceUrl: item.sourceUrl ? displayUrl(item.sourceUrl) : null,
          errorCode: ERROR_CODES.jobWorkerLost,
          errorDetail: 'The job writing this file stopped without finishing',
        },
      });
      result.lostTransfers += updated.count;
    }

    // --- 2. uploads nobody finished ------------------------------------------
    const abandoned = await prisma.libraryItem.findMany({
      where: {
        source: 'UPLOAD',
        state: 'RECEIVING',
        jobId: null,
        updatedAt: { lt: new Date(now.getTime() - ABANDONED_UPLOAD_MS) },
      },
      select: { id: true },
    });
    for (const item of abandoned) {
      await rm(paths.partial(item.id), { force: true });
      await prisma.libraryItem.deleteMany({
        where: { id: item.id, state: 'RECEIVING', jobId: null },
      });
      result.abandonedUploads += 1;
    }

    // --- 3. files nothing points at ------------------------------------------
    const rows = new Map(
      (await prisma.libraryItem.findMany({ select: { id: true, state: true } })).map((row) => [
        row.id,
        row.state,
      ]),
    );
    for (const [dir, wanted] of [
      ['partial', new Set(['RECEIVING', 'VERIFYING'])],
      ['items', new Set(['READY'])],
    ] as const) {
      let names: string[] = [];
      try {
        names = await readdir(join(paths.root, dir));
      } catch {
        continue;
      }
      for (const name of names) {
        const state = rows.get(name);
        if (state && wanted.has(state)) continue;
        // A partial younger than a minute may belong to an upload whose row is
        // being written right now.
        const info = await stat(join(paths.root, dir, name)).catch(() => null);
        if (dir === 'partial' && info && now.getTime() - info.mtimeMs < 60_000) continue;
        await rm(join(paths.root, dir, name), { force: true, recursive: true });
        result.orphanFiles += 1;
      }
    }

    // --- 4. rows that promise a file that is not there -----------------------
    const ready = await prisma.libraryItem.findMany({
      where: { state: 'READY' },
      select: { id: true },
    });
    for (const item of ready) {
      const exists = await stat(paths.item(item.id)).then(
        () => true,
        () => false,
      );
      if (exists) continue;
      await prisma.libraryItem.update({
        where: { id: item.id },
        data: {
          state: 'FAILED',
          errorCode: ERROR_CODES.libraryFileMissing,
          errorDetail: 'The file is no longer in the library volume',
        },
      });
      result.missingFiles += 1;
    }

    return result;
  });
}

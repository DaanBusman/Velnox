import { mkdir, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { GIB, type LibraryCapacity } from '@velnox/shared';
import type { VelnoxPrismaClient } from './client';

/**
 * Where the library keeps its bytes, and how full it is.
 *
 * Here rather than in the API or the worker because both write to the library
 * — the API receives upload chunks, the worker fetches, verifies and copies —
 * and a capacity rule computed two ways is two rules.
 */

export interface LibraryLimits {
  dir: string;
  maxGb: number;
  minFreeGb: number;
}

export interface LibraryPaths {
  root: string;
  /** Where a finished item lives. Named by id, never by a filename a person typed. */
  item(id: string): string;
  /** Where an item's bytes arrive. Renamed to `item(id)` only once checked. */
  partial(id: string): string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function libraryPaths(root: string): LibraryPaths {
  /*
   * The id is checked even though every caller got it from the database: this
   * is the one function that turns something into a path under the library,
   * and a path built from an unchecked string is how a `..` ends up in one.
   */
  const safe = (id: string): string => {
    if (!UUID.test(id)) throw new Error(`Not a library item id: ${id.slice(0, 40)}`);
    return id.toLowerCase();
  };
  return {
    root,
    item: (id) => join(root, 'items', safe(id)),
    partial: (id) => join(root, 'partial', safe(id)),
  };
}

export async function ensureLibraryDirs(root: string): Promise<void> {
  await mkdir(join(root, 'items'), { recursive: true });
  await mkdir(join(root, 'partial'), { recursive: true });
}

/**
 * The library's capacity, as the next transfer should see it.
 *
 * **Used** counts every item that is not FAILED at its full size — a transfer
 * in progress has reserved its space from the moment it was accepted, so two
 * uploads started together cannot both fit into the same last 10 GB.
 *
 * **Disk free** is what the filesystem reports, less what transfers in
 * progress have yet to write. The filesystem only knows about bytes already
 * written; without the correction, a 6 GB upload that has written 1 GB would
 * leave 5 GB invisible to the floor.
 *
 * `excludeItemId` leaves one item out of both, for checking that item itself.
 */
export async function readLibraryCapacity(
  prisma: VelnoxPrismaClient,
  limits: LibraryLimits,
  excludeItemId?: string,
): Promise<LibraryCapacity> {
  const items = await prisma.libraryItem.findMany({
    where: { state: { not: 'FAILED' }, ...(excludeItemId ? { id: { not: excludeItemId } } : {}) },
    select: { state: true, sizeBytes: true, receivedBytes: true },
  });

  let usedBytes = 0;
  let outstandingBytes = 0;
  for (const item of items) {
    const size = item.sizeBytes === null ? Number(item.receivedBytes) : Number(item.sizeBytes);
    usedBytes += size;
    if (item.state === 'RECEIVING' && item.sizeBytes !== null) {
      outstandingBytes += Math.max(0, Number(item.sizeBytes) - Number(item.receivedBytes));
    }
  }

  const fs = await statfs(limits.dir);
  const filesystemFree = Number(fs.bavail) * Number(fs.bsize);

  return {
    ceilingBytes: limits.maxGb * GIB,
    usedBytes,
    diskFreeBytes: Math.max(0, filesystemFree - outstandingBytes),
    diskFloorBytes: limits.minFreeGb * GIB,
  };
}

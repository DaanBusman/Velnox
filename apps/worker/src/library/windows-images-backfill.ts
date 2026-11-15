import { stat } from 'node:fs/promises';
import { withSystemScope, type Prisma } from '@velnox/db';
import type { LibraryServices } from './services';
import { readWindowsImages, WINDOWS_IMAGES_READER_VERSION } from './windows-images';

/**
 * Read the editions and languages of every ISO the current reader has not.
 *
 * An ISO is read when it enters the library. One that entered before the
 * reader existed — or before a reader that understands it better — kept an
 * empty list, and the template form fell back to a typed edition and a fixed
 * list of languages for an ISO that has both written inside it. This reads
 * those, at start-up and with every library sweep. Reading one is a directory
 * walk and one small XML — kilobytes, not the gigabytes of the file — so every
 * ISO waiting is read in one pass, in batches so a large library is not one
 * query.
 *
 * The version is written whatever was found, so an ISO that is not a Windows
 * installer is read once per reader version, not on every sweep.
 */
export const BACKFILL_BATCH = 20;

export async function backfillWindowsImages(
  services: LibraryServices,
): Promise<{ read: number; found: number }> {
  return withSystemScope('reading ISOs belongs to no request', async () => {
    const { prisma, paths } = services;
    let read = 0;
    let found = 0;
    // A READY row whose file is missing is the sweep's to fail, not this
    // pass's to read. It is passed over, and left out of the next batch, so it
    // cannot bring the same batch back for ever.
    const passedOver: string[] = [];

    for (;;) {
      const items = await prisma.libraryItem.findMany({
        where: {
          kind: 'ISO',
          state: 'READY',
          id: { notIn: passedOver },
          OR: [
            { windowsImagesVersion: null },
            { windowsImagesVersion: { lt: WINDOWS_IMAGES_READER_VERSION } },
          ],
        },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
        take: BACKFILL_BATCH,
      });

      for (const item of items) {
        const file = paths.item(item.id);
        if (!(await stat(file).catch(() => null))) {
          passedOver.push(item.id);
          continue;
        }
        const images = await readWindowsImages(file);
        if (images) found += 1;
        read += 1;
        await prisma.libraryItem.updateMany({
          // Still READY: a delete between the read and the write wins.
          where: { id: item.id, state: 'READY' },
          data: {
            // A list that was there stays when this read finds none: a reader
            // that understands less is a bug to fix, not a fact to record.
            ...(images ? { windowsImages: images as unknown as Prisma.InputJsonValue } : {}),
            windowsImagesVersion: WINDOWS_IMAGES_READER_VERSION,
          },
        });
      }

      if (items.length < BACKFILL_BATCH) break;
    }
    return { read, found };
  });
}

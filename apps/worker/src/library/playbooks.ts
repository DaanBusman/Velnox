import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, rename, rm, stat } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Prisma } from '@velnox/db';
import { waitForTask, type ProxmoxClient } from '@velnox/proxmox';
import {
  ERROR_CODES,
  GIB,
  SNIFF_BYTES,
  checkCapacity,
  contentTypeFor,
  displayUrl,
  importFilename,
  parseClusterVolumeParams,
  parseLibraryItemParams,
  parseLibraryPullParams,
  parseLibraryPushParams,
  parseVolumeId,
  sniffLibraryContent,
  volumeId,
} from '@velnox/shared';
import { StepError, type Playbook, type StepContext } from '../jobs/steps';
import { downloadToFile } from './fetch';
import type { LibraryServices } from './services';
import { withSftp } from './ssh';
import { readWindowsImages, type WindowsImage } from './windows-images';

/**
 * The library's jobs.
 *
 * Five of them, and one rule they share: **a job that does not finish leaves
 * nothing behind.** A cancelled fetch leaves no partial file in the library; a
 * cancelled push leaves no half-file on the node; a failed one records why and
 * then tidies up the same way. That is what `cleanup` is for, and the runner
 * runs it before it records the final state.
 *
 * Every log line names the real filename. Friendly names are for screens.
 */

type Item = NonNullable<
  Awaited<ReturnType<LibraryServices['prisma']['libraryItem']['findUnique']>>
>;

/** How often progress is written while bytes move. */
const PROGRESS_EVERY_MS = 1_000;

/**
 * Progress from a stream's point of view — called for every chunk, synchronous
 * — turned into the runner's point of view: asynchronous, and at most once a
 * second. A failure while reporting (the job was taken from this worker) is
 * held and thrown at the end of the step rather than lost in a callback.
 */
function progressReporter(report: (bytes: number) => Promise<void>) {
  let last = 0;
  let pending: Promise<void> = Promise.resolve();
  let failure: unknown = null;
  return {
    update(bytes: number): void {
      const now = Date.now();
      if (now - last < PROGRESS_EVERY_MS) return;
      last = now;
      pending = pending
        .then(() => report(bytes))
        .catch((error: unknown) => {
          failure = error;
        });
    },
    async flush(): Promise<void> {
      await pending;
      if (failure) throw failure;
    },
  };
}

const percent = (done: number, total: number | null): number =>
  total && total > 0 ? Math.min(100, (done / total) * 100) : 0;

async function loadItem(services: LibraryServices, itemId: string): Promise<Item> {
  const item = await services.prisma.libraryItem.findUnique({ where: { id: itemId } });
  if (!item) throw new StepError(ERROR_CODES.notFound, `No library item ${itemId}`);
  return item;
}

/** Refuse with the numbers an operator needs, when `bytes` more will not fit. */
async function assertCapacity(
  services: LibraryServices,
  itemId: string,
  bytes: number,
): Promise<void> {
  const refusal = checkCapacity(await services.capacity(itemId), bytes);
  if (refusal) {
    throw new StepError(
      refusal.code,
      `The library cannot take ${bytes} more bytes`,
      refusal.params,
    );
  }
}

/** Bytes the library may still accept for this item, under both limits. */
async function headroom(services: LibraryServices, itemId: string): Promise<number> {
  const capacity = await services.capacity(itemId);
  return Math.max(
    0,
    Math.min(
      capacity.ceilingBytes - capacity.usedBytes,
      capacity.diskFreeBytes - capacity.diskFloorBytes,
    ),
  );
}

async function hashFile(
  path: string,
  context: StepContext,
  total: number | null,
): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256');
  let bytes = 0;
  const reporter = progressReporter((done) => context.progress(percent(done, total)));
  await pipeline(
    createReadStream(path),
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        bytes += chunk.length;
        reporter.update(bytes);
        callback();
      },
    }),
    { signal: context.signal },
  );
  await reporter.flush();
  return { bytes, sha256: hash.digest('hex') };
}

/**
 * Check the bytes are what the name says, then move them into place.
 *
 * The last step of every job that brings a file in. Until it runs, the file is
 * a partial that nothing offers anyone; after it, the item is READY and its
 * checksum is the one every later push is checked against.
 */
async function publish(
  services: LibraryServices,
  item: Item,
  checked: { bytes: number; sha256: string },
): Promise<Record<string, string | number>> {
  const partial = services.paths.partial(item.id);

  const handle = await open(partial, 'r');
  const head = Buffer.alloc(SNIFF_BYTES);
  try {
    await handle.read(head, 0, SNIFF_BYTES, 0);
  } finally {
    await handle.close();
  }
  const sniffed = sniffLibraryContent(head);

  let diskFormat: 'qcow2' | 'raw' | null = null;
  let windowsImages: WindowsImage[] | null = null;
  if (item.kind === 'ISO') {
    if (!sniffed.iso) {
      throw new StepError(
        ERROR_CODES.libraryWrongContent,
        `${item.filename} is named as an ISO but is not an ISO image`,
        { filename: item.filename },
      );
    }
    // A Windows installer's editions, for the template form to offer. Null
    // for any other ISO, and for one whose list cannot be read with certainty.
    windowsImages = await readWindowsImages(partial);
  } else {
    diskFormat = sniffed.qcow2 ? 'qcow2' : 'raw';
    if (item.filename.toLowerCase().endsWith('.qcow2') && !sniffed.qcow2) {
      throw new StepError(
        ERROR_CODES.libraryWrongContent,
        `${item.filename} is named as qcow2 but is not a qcow2 image`,
        { filename: item.filename },
      );
    }
    if (sniffed.iso) {
      throw new StepError(
        ERROR_CODES.libraryWrongContent,
        `${item.filename} is named as a disk image but is an ISO`,
        { filename: item.filename },
      );
    }
  }

  await rename(partial, services.paths.item(item.id));
  await services.prisma.libraryItem.update({
    where: { id: item.id },
    data: {
      state: 'READY',
      sizeBytes: BigInt(checked.bytes),
      receivedBytes: BigInt(checked.bytes),
      sha256: checked.sha256,
      diskFormat,
      // Written only when there is one: a fresh item's column is already null.
      ...(windowsImages
        ? { windowsImages: windowsImages as unknown as Prisma.InputJsonValue }
        : {}),
      readyAt: new Date(),
      jobId: null,
      errorCode: null,
      errorDetail: null,
    },
  });

  return {
    filename: item.filename,
    bytes: checked.bytes,
    sha256: checked.sha256,
    ...(windowsImages ? { editions: windowsImages.map((image) => image.name).join(', ') } : {}),
  };
}

/**
 * The cleanup for every job that brings a file in.
 *
 * Cancelled: as if it never happened — no partial, no item. Failed: no
 * partial, and the item kept as FAILED with its reason, so the screen says why
 * rather than the file simply not appearing. A READY item is never touched.
 */
function inboundCleanup(services: LibraryServices, itemId: string, lastError: () => unknown) {
  return async (reason: 'cancelled' | 'failed'): Promise<void> => {
    await rm(services.paths.partial(itemId), { force: true });
    const item = await services.prisma.libraryItem.findUnique({ where: { id: itemId } });
    if (!item || item.state === 'READY') return;

    if (reason === 'cancelled') {
      await services.prisma.libraryItem.delete({ where: { id: itemId } });
      return;
    }
    const error = lastError();
    await services.prisma.libraryItem.update({
      where: { id: itemId },
      data: {
        state: 'FAILED',
        jobId: null,
        // A failed fetch keeps where it came from, minus a signed link's token.
        sourceUrl: item.sourceUrl ? displayUrl(item.sourceUrl) : null,
        errorCode: error instanceof StepError ? error.code : ERROR_CODES.generic,
        errorParams: error instanceof StepError && error.params ? error.params : undefined,
        errorDetail:
          error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
      },
    });
  };
}

/** Remember the error a step threw, for the cleanup to record. */
function remembering<T>(sink: { error: unknown }, run: () => Promise<T>): Promise<T> {
  return run().catch((error: unknown) => {
    sink.error = error;
    throw error;
  });
}

// ---------------------------------------------------------------------------
// library.fetch — a URL into the library
// ---------------------------------------------------------------------------

export function fetchPlaybook(raw: unknown, jobId: string, services: LibraryServices): Playbook {
  const { itemId } = parseLibraryItemParams(raw);
  const failure = { error: null as unknown };
  let fetched: { bytes: number; sha256: string } | null = null;

  return {
    version: 1,
    steps: [
      {
        kind: 'task',
        key: 'download',
        phase: 'transfer',
        run: (context) =>
          remembering(failure, async () => {
            const item = await loadItem(services, itemId);
            if (item.state !== 'RECEIVING' || item.source !== 'URL' || !item.sourceUrl) {
              throw new StepError(
                ERROR_CODES.libraryNotReady,
                `Item ${itemId} is not waiting for a download`,
              );
            }
            await services.prisma.libraryItem.update({ where: { id: itemId }, data: { jobId } });
            await rm(services.paths.partial(itemId), { force: true });

            await context.log(
              'STDOUT',
              `Fetching ${item.filename} from ${displayUrl(item.sourceUrl)}`,
            );

            let declared: number | null = null;
            const reporter = progressReporter(async (bytes) => {
              await services.prisma.libraryItem.update({
                where: { id: itemId },
                data: { receivedBytes: BigInt(bytes) },
              });
              await context.progress(percent(bytes, declared));
            });

            const result = await downloadToFile({
              url: item.sourceUrl,
              destination: services.paths.partial(itemId),
              signal: context.signal,
              blocked: services.blocked,
              maxBytes: await headroom(services, itemId),
              userAgent: services.userAgent,
              onStart: async (size) => {
                declared = size;
                if (size !== null) {
                  await assertCapacity(services, itemId, size);
                  await services.prisma.libraryItem.update({
                    where: { id: itemId },
                    data: { sizeBytes: BigInt(size) },
                  });
                  await context.log('STDOUT', `The server declares ${size} bytes`);
                } else {
                  await context.log(
                    'STDOUT',
                    'The server did not declare a size; the library limits still apply',
                  );
                }
              },
              onProgress: (bytes) => reporter.update(bytes),
            });
            await reporter.flush();

            await services.prisma.libraryItem.update({
              where: { id: itemId },
              data: {
                state: 'VERIFYING',
                sizeBytes: BigInt(result.bytes),
                receivedBytes: BigInt(result.bytes),
                // Nothing needs the query string again, and a signed link's
                // token is in it. Kept only for as long as the download ran.
                sourceUrl: displayUrl(item.sourceUrl),
              },
            });
            fetched = { bytes: result.bytes, sha256: result.sha256 };
            await context.log(
              'STDOUT',
              `Received ${result.bytes} bytes of ${item.filename}, sha256 ${result.sha256}`,
            );
            return { bytes: result.bytes, sha256: result.sha256 };
          }),
      },
      {
        kind: 'task',
        key: 'verify',
        phase: 'verify',
        run: (context) =>
          remembering(failure, async () => {
            const item = await loadItem(services, itemId);
            // Re-hashed only if this worker is not the one that downloaded it:
            // a job resumed after an approval or a restart has no checksum in
            // memory, and trusting one it did not compute would be trusting a
            // file it did not read.
            const checked =
              fetched ??
              (await hashFile(services.paths.partial(itemId), context, Number(item.sizeBytes)));
            const output = await publish(services, item, checked);
            await context.log('STDOUT', `${item.filename} is in the library`);
            return output;
          }),
      },
    ],
    cleanup: inboundCleanup(services, itemId, () => failure.error),
  };
}

// ---------------------------------------------------------------------------
// library.verify — an uploaded file, checked and made available
// ---------------------------------------------------------------------------

export function verifyPlaybook(raw: unknown, jobId: string, services: LibraryServices): Playbook {
  const { itemId } = parseLibraryItemParams(raw);
  const failure = { error: null as unknown };
  let checked: { bytes: number; sha256: string } | null = null;

  return {
    version: 1,
    steps: [
      {
        kind: 'task',
        key: 'checksum',
        phase: 'verify',
        run: (context) =>
          remembering(failure, async () => {
            const item = await loadItem(services, itemId);
            if (item.state !== 'VERIFYING' || item.sizeBytes === null) {
              throw new StepError(ERROR_CODES.libraryNotReady, `Upload ${itemId} is not complete`);
            }
            await services.prisma.libraryItem.update({ where: { id: itemId }, data: { jobId } });

            const size = Number(item.sizeBytes);
            checked = await hashFile(services.paths.partial(itemId), context, size);
            if (checked.bytes !== size) {
              throw new StepError(
                ERROR_CODES.librarySizeMismatch,
                `${item.filename}: ${size} bytes were declared and ${checked.bytes} are on disk`,
                { filename: item.filename },
              );
            }
            await context.log(
              'STDOUT',
              `${item.filename}: ${checked.bytes} bytes, sha256 ${checked.sha256}`,
            );
            return { bytes: checked.bytes, sha256: checked.sha256 };
          }),
      },
      {
        kind: 'task',
        key: 'verify',
        phase: 'verify',
        run: (context) =>
          remembering(failure, async () => {
            const item = await loadItem(services, itemId);
            const result =
              checked ??
              (await hashFile(services.paths.partial(itemId), context, Number(item.sizeBytes)));
            const output = await publish(services, item, result);
            await context.log('STDOUT', `${item.filename} is in the library`);
            return output;
          }),
      },
    ],
    cleanup: inboundCleanup(services, itemId, () => failure.error),
  };
}

// ---------------------------------------------------------------------------
// library.push — onto a cluster's storage
// ---------------------------------------------------------------------------

/** A little room beyond the file itself, for the temporary copy pveproxy writes. */
const STORAGE_MARGIN_BYTES = 256 * 1024 * 1024;

export function pushPlaybook(raw: unknown, services: LibraryServices): Playbook {
  const params = parseLibraryPushParams(raw);

  /*
   * What the cleanup needs to know, filled in as the job gets there. `target`
   * is set only after the check step proved the volume was absent, which is
   * what makes deleting it afterwards safe: anything at that name is ours.
   */
  let client: ProxmoxClient | null = null;
  let target: { volid: string; filename: string; size: number } | null = null;
  let upid: string | null = null;
  let confirmed = false;

  const connect = async (): Promise<ProxmoxClient> => {
    if (!client) client = (await services.connect(params.clusterId)).client;
    return client;
  };

  return {
    version: 1,
    steps: [
      {
        kind: 'task',
        key: 'check',
        phase: 'preflight',
        run: async (context) => {
          const item = await loadItem(services, params.itemId);
          if (item.state !== 'READY' || !item.sha256 || item.sizeBytes === null) {
            throw new StepError(
              ERROR_CODES.libraryNotReady,
              `${item.filename} is not ready to push`,
              {
                filename: item.filename,
              },
            );
          }
          const pve = await connect();
          const content = contentTypeFor(item.kind);
          const status = await pve.storageStatus(params.node, params.storage);
          const types = (status.content ?? '').split(',').map((part) => part.trim());

          if (status.enabled === 0 || status.active === 0 || !types.includes(content)) {
            throw new StepError(
              ERROR_CODES.libraryStorageUnsuitable,
              `${params.storage} on ${params.node} does not take ${content} content`,
              { storage: params.storage, node: params.node, content },
            );
          }

          const size = Number(item.sizeBytes);
          if (typeof status.avail === 'number' && status.avail < size + STORAGE_MARGIN_BYTES) {
            throw new StepError(
              ERROR_CODES.libraryStorageFull,
              `${params.storage} has ${status.avail} bytes free; ${item.filename} needs ${size}`,
              {
                storage: params.storage,
                freeGb: Math.round((status.avail / GIB) * 10) / 10,
                neededGb: Math.round((size / GIB) * 10) / 10,
              },
            );
          }

          const filename =
            item.kind === 'DISK_IMAGE'
              ? importFilename(item.filename, item.diskFormat === 'qcow2' ? 'qcow2' : 'raw')
              : item.filename;
          const volid = volumeId(params.storage, item.kind, filename);

          const existing = await pve.storageContent(params.node, params.storage, content);
          if (existing.some((entry) => entry.volid === volid)) {
            throw new StepError(ERROR_CODES.libraryAlreadyOnStorage, `${volid} is already there`, {
              volid,
            });
          }

          target = { volid, filename, size };
          await context.log(
            'STDOUT',
            `Pushing ${item.filename} to ${params.node}:${params.storage} as ${volid}`,
          );
          return { volid, bytes: size };
        },
      },
      {
        kind: 'task',
        key: 'upload',
        phase: 'transfer',
        run: async (context) => {
          const item = await loadItem(services, params.itemId);
          if (!target) throw new StepError(ERROR_CODES.generic, 'The push was not checked');
          const pve = await connect();
          const { filename, size } = target;

          const reporter = progressReporter((bytes) =>
            context.progress(percent(bytes, size) * 0.95),
          );
          await context.log(
            'STDOUT',
            `Sending ${filename} with sha256 ${item.sha256}; Proxmox checks it on arrival and refuses a mismatch`,
          );
          upid = await pve.uploadToStorage(params.node, params.storage, {
            content: contentTypeFor(item.kind),
            filename,
            size,
            open: () => createReadStream(services.paths.item(item.id)),
            sha256: item.sha256 ?? undefined,
            signal: context.signal,
            onProgress: (bytes) => reporter.update(bytes),
          });
          await reporter.flush();
          await context.log('STDOUT', `All ${size} bytes sent; Proxmox task ${upid}`);

          const outcome = await waitForTask(pve, upid, {
            signal: context.signal,
            timeoutMs: 60 * 60 * 1000,
          });
          if (!outcome.succeeded) {
            const log = await pve.taskLog(params.node, upid).catch(() => []);
            const text = log.map((line) => line.t).join('\n');
            await context.log('STDERR', text.slice(-4000));
            throw /checksum/i.test(text) || /checksum/i.test(outcome.exitStatus)
              ? new StepError(
                  ERROR_CODES.libraryChecksumMismatch,
                  `Proxmox refused ${filename}: checksum mismatch`,
                  {
                    filename,
                  },
                )
              : new StepError(
                  ERROR_CODES.generic,
                  `Proxmox task ${upid} ended with ${outcome.exitStatus}`,
                );
          }
          upid = null;
          await context.progress(100);
          return { task: outcome.upid, exitStatus: outcome.exitStatus };
        },
      },
      {
        kind: 'task',
        key: 'confirm',
        phase: 'verify',
        run: async (context) => {
          if (!target) throw new StepError(ERROR_CODES.generic, 'The push was not checked');
          const pve = await connect();
          const listed = await pve.storageContent(params.node, params.storage);
          const found = listed.find((entry) => entry.volid === target!.volid);
          if (!found) {
            throw new StepError(
              ERROR_CODES.libraryNotOnStorage,
              `${target.volid} is not in the storage listing`,
              {
                volid: target.volid,
              },
            );
          }
          if (typeof found.size === 'number' && found.size !== target.size) {
            throw new StepError(
              ERROR_CODES.librarySizeMismatch,
              `${target.volid} is ${found.size} bytes on the node; ${target.size} were sent`,
              { filename: target.filename },
            );
          }
          confirmed = true;
          await services.refreshContents(params.clusterId).catch(() => undefined);
          await context.log('STDOUT', `${target.volid} is on ${params.node}, ${target.size} bytes`);
          return { volid: target.volid };
        },
      },
    ],

    async cleanup() {
      if (!target || confirmed) {
        (client as ProxmoxClient | null)?.close();
        return;
      }
      try {
        const pve = await connect();
        if (upid) await pve.stopTask(params.node, upid).catch(() => null);
        // The check step proved nothing was at this name before the job, so
        // whatever is there now is this job's own half-finished work.
        const listed = await pve.storageContent(params.node, params.storage);
        if (listed.some((entry) => entry.volid === target!.volid)) {
          await pve.deleteVolume(params.node, params.storage, target.volid);
        }
        await services.refreshContents(params.clusterId).catch(() => undefined);
      } finally {
        (client as ProxmoxClient | null)?.close();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// library.cluster_delete — off a cluster's storage
// ---------------------------------------------------------------------------

export function clusterDeletePlaybook(raw: unknown, services: LibraryServices): Playbook {
  const params = parseClusterVolumeParams(raw);
  let client: ProxmoxClient | null = null;
  const connect = async (): Promise<ProxmoxClient> => {
    if (!client) client = (await services.connect(params.clusterId)).client;
    return client;
  };

  return {
    version: 1,
    steps: [
      {
        kind: 'task',
        key: 'delete',
        phase: 'transfer',
        run: async (context) => {
          const pve = await connect();
          const listed = await pve.storageContent(params.node, params.storage);
          if (!listed.some((entry) => entry.volid === params.volid)) {
            throw new StepError(ERROR_CODES.libraryNotOnStorage, `${params.volid} is not there`, {
              volid: params.volid,
            });
          }
          await context.log(
            'STDOUT',
            `Deleting ${params.volid} from ${params.node}:${params.storage}`,
          );
          const upid = await pve.deleteVolume(params.node, params.storage, params.volid);
          if (typeof upid === 'string' && upid.startsWith('UPID:')) {
            const outcome = await waitForTask(pve, upid, {
              signal: context.signal,
              timeoutMs: 10 * 60 * 1000,
            });
            if (!outcome.succeeded) {
              throw new StepError(
                ERROR_CODES.generic,
                `Proxmox task ${upid} ended with ${outcome.exitStatus}`,
              );
            }
          }
          return { volid: params.volid };
        },
      },
      {
        kind: 'task',
        key: 'confirm',
        phase: 'verify',
        run: async (context) => {
          const pve = await connect();
          const listed = await pve.storageContent(params.node, params.storage);
          if (listed.some((entry) => entry.volid === params.volid)) {
            throw new StepError(
              ERROR_CODES.generic,
              `${params.volid} is still listed after deleting it`,
            );
          }
          await services.refreshContents(params.clusterId).catch(() => undefined);
          await context.log(
            'STDOUT',
            `${params.volid} is gone from ${params.node}:${params.storage}`,
          );
          (client as ProxmoxClient | null)?.close();
          return { volid: params.volid };
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// library.pull — off a cluster, into the library, over SSH
// ---------------------------------------------------------------------------

export function pullPlaybook(raw: unknown, jobId: string, services: LibraryServices): Playbook {
  const params = parseLibraryPullParams(raw);
  const failure = { error: null as unknown };
  let source: { path: string; size: number } | null = null;

  return {
    version: 1,
    steps: [
      {
        kind: 'task',
        key: 'locate',
        phase: 'preflight',
        run: (context) =>
          remembering(failure, async () => {
            const item = await loadItem(services, params.itemId);
            if (item.state !== 'RECEIVING' || item.source !== 'CLUSTER') {
              throw new StepError(
                ERROR_CODES.libraryNotReady,
                `Item ${params.itemId} is not waiting for a copy`,
              );
            }
            await services.prisma.libraryItem.update({ where: { id: item.id }, data: { jobId } });

            const { client } = await services.connect(params.clusterId);
            let attributes;
            try {
              attributes = await client.volumeAttributes(params.node, params.storage, params.volid);
            } finally {
              client.close();
            }

            const expected = parseVolumeId(params.volid)!.filename;
            const path = attributes.path ?? '';
            // The path comes from the node. It is only ever used to read one
            // file, but it is still checked to be the file that was asked for.
            if (!path.startsWith('/') || path.includes('..') || !path.endsWith(`/${expected}`)) {
              throw new StepError(
                ERROR_CODES.generic,
                `Proxmox gave an unexpected path for ${params.volid}`,
              );
            }
            const size =
              typeof attributes.size === 'number' ? attributes.size : Number(item.sizeBytes ?? 0);
            await assertCapacity(services, item.id, size);
            await services.prisma.libraryItem.update({
              where: { id: item.id },
              data: { sizeBytes: BigInt(size) },
            });

            source = { path, size };
            await context.log(
              'STDOUT',
              `Copying ${params.volid} (${size} bytes) from ${params.node} over SFTP`,
            );
            return { path, bytes: size };
          }),
      },
      {
        kind: 'task',
        key: 'copy',
        phase: 'transfer',
        run: (context) =>
          remembering(failure, async () => {
            if (!source) throw new StepError(ERROR_CODES.generic, 'The copy was not located');
            const { path, size } = source;
            const target = await services.sshTarget(params.clusterId, params.node);
            const destination = services.paths.partial(params.itemId);
            await rm(destination, { force: true });

            const reporter = progressReporter(async (done) => {
              await services.prisma.libraryItem.update({
                where: { id: params.itemId },
                data: { receivedBytes: BigInt(done) },
              });
              await context.progress(percent(done, size));
            });

            /*
             * Many reads in flight, not one at a time.
             *
             * A stream over SFTP asks for one block and waits for it before
             * asking for the next, so its speed is the block size divided by the
             * round trip — about 3 MB/s to a node 20 ms away, whatever the link.
             * Measured against the fixture at 0.4 MB/s. OpenSSH's own client
             * keeps dozens of requests outstanding; `fastGet` does the same.
             * The checksum is then computed over the local copy, in `verify`.
             */
            await withSftp(
              target,
              context.signal,
              (sftp) =>
                new Promise<void>((resolve, reject) => {
                  sftp.fastGet(
                    path,
                    destination,
                    {
                      concurrency: 32,
                      chunkSize: 256 * 1024,
                      fileSize: size,
                      step: (transferred) => reporter.update(transferred),
                    },
                    (error) => (error ? reject(error) : resolve()),
                  );
                }),
            );
            await reporter.flush();

            const bytes = (await stat(destination)).size;
            if (bytes !== size) {
              throw new StepError(
                ERROR_CODES.librarySizeMismatch,
                `Copied ${bytes} of ${size} bytes of ${path}`,
              );
            }
            await services.prisma.libraryItem.update({
              where: { id: params.itemId },
              data: { state: 'VERIFYING', receivedBytes: BigInt(bytes) },
            });
            await context.log('STDOUT', `Copied ${bytes} bytes of ${path}`);
            return { bytes };
          }),
      },
      {
        kind: 'task',
        key: 'verify',
        phase: 'verify',
        run: (context) =>
          remembering(failure, async () => {
            const item = await loadItem(services, params.itemId);
            const checked = await hashFile(
              services.paths.partial(item.id),
              context,
              Number(item.sizeBytes),
            );
            await context.log('STDOUT', `${item.filename}: sha256 ${checked.sha256}`);
            const output = await publish(services, item, checked);
            await context.log('STDOUT', `${item.filename} is in the library`);
            return output;
          }),
      },
    ],
    cleanup: inboundCleanup(services, params.itemId, () => failure.error),
  };
}

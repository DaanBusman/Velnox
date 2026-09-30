import type { JobDetail, LibraryItemSummary } from '@velnox/shared';
import { apiGet, apiPost, apiPutBinary, type ApiFailure } from '@/lib/client-api';

/**
 * A browser upload into the library: in chunks, resumable.
 *
 * An ISO is gigabytes and a browser tab is not a reliable place to hold a
 * connection open for an hour. So the file goes up in 32 MiB slices, each one
 * written at the position the API says the upload is at; a slice that fails for
 * a network reason is sent again, and an upload whose tab was closed is picked
 * up later by choosing the same file again — the API knows how far it got.
 */

const RETRIES = 5;

export type UploadOutcome =
  { ok: true; item: LibraryItemSummary; job: JobDetail | null } | { ok: false; error: ApiFailure };

export async function uploadToLibrary(input: {
  file: File;
  /** Continue this upload rather than starting a new one. */
  resume?: LibraryItemSummary;
  onProgress: (sent: number, total: number) => void;
  signal: AbortSignal;
}): Promise<UploadOutcome> {
  const { file, signal } = input;

  let item: LibraryItemSummary;
  let chunkBytes = 32 * 1024 * 1024;

  if (input.resume) {
    // The same name and size, or it is not the same file. A checksum would be
    // stronger, and would mean reading the whole file before sending a byte.
    if (input.resume.filename !== file.name || input.resume.sizeBytes !== file.size) {
      return { ok: false, error: { code: 'library.resume_mismatch', status: 0 } };
    }
    const current = await apiGet<LibraryItemSummary>(`/library/uploads/${input.resume.id}`);
    if (!current.ok) return current;
    item = current.data;
  } else {
    const started = await apiPost<{ item: LibraryItemSummary; chunkBytes: number }>(
      '/library/uploads',
      {
        filename: file.name,
        sizeBytes: file.size,
      },
    );
    if (!started.ok) return started;
    item = started.data.item;
    chunkBytes = started.data.chunkBytes;
  }

  let offset = item.receivedBytes;
  let job: JobDetail | null = null;
  input.onProgress(offset, file.size);

  while (offset < file.size) {
    const end = Math.min(file.size, offset + chunkBytes);
    let attempt = 0;
    for (;;) {
      if (signal.aborted) return { ok: false, error: { code: 'library.upload_paused', status: 0 } };
      const sent = await apiPutBinary<{ item: LibraryItemSummary; job: JobDetail | null }>(
        `/library/uploads/${item.id}/chunks?offset=${offset}`,
        file.slice(offset, end),
        signal,
      );
      if (sent.ok) {
        item = sent.data.item;
        job = sent.data.job;
        break;
      }
      // The API is somewhere else than we thought — a retry of a chunk that
      // did arrive, or two tabs. Go to where it says.
      if (
        sent.error.code === 'library.upload_offset' &&
        typeof sent.error.params?.expected === 'number'
      ) {
        offset = sent.error.params.expected;
        break;
      }
      const transient =
        sent.error.code === 'network' ||
        sent.error.status >= 500 ||
        sent.error.code === 'library.size_mismatch';
      attempt += 1;
      if (!transient || attempt > RETRIES) return sent;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
    offset = Math.max(offset, item.receivedBytes);
    input.onProgress(offset, file.size);
  }

  return { ok: true, item, job };
}

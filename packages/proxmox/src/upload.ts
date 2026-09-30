import { randomBytes } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';

/**
 * The multipart body Proxmox's upload endpoint expects, built around a stream.
 *
 * Proxmox's own web interface posts `content`, then the checksum fields, then
 * the file, in that order, and `pveproxy` reads the form as it arrives — the
 * parameters have to be in front of the file or it has not seen them by the
 * time the file starts. So the envelope is fixed: every field first, the file
 * part last, and nothing after it but the closing boundary.
 *
 * Built by hand rather than with a form library because the length has to be
 * known up front. `pveproxy` refuses a chunked upload, and a form library that
 * streams does not know its total length.
 */

export interface MultipartFields {
  [name: string]: string;
}

export interface Envelope {
  boundary: string;
  head: Buffer;
  tail: Buffer;
  /** The whole body: head, file, tail. */
  length: number;
}

const CRLF = '\r\n';

/** A field or filename that would break out of its part is refused, not escaped. */
const SAFE = /^[A-Za-z0-9._:-]*$/;

export function multipartEnvelope(input: {
  fields: MultipartFields;
  fileField: string;
  filename: string;
  fileSize: number;
  boundary?: string;
}): Envelope {
  const boundary = input.boundary ?? `----velnox${randomBytes(12).toString('hex')}`;

  for (const [name, value] of Object.entries(input.fields)) {
    if (!SAFE.test(name) || !SAFE.test(value)) {
      throw new Error(`Refusing to put an unsafe value into a multipart field: ${name}`);
    }
  }
  if (!SAFE.test(input.filename) || !SAFE.test(input.fileField)) {
    throw new Error('Refusing to put an unsafe filename into a multipart header');
  }

  const parts = Object.entries(input.fields).map(
    ([name, value]) =>
      `--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`,
  );

  const head = Buffer.from(
    parts.join('') +
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="${input.fileField}"; filename="${input.filename}"${CRLF}` +
      `Content-Type: application/octet-stream${CRLF}${CRLF}`,
    'utf8',
  );
  const tail = Buffer.from(`${CRLF}--${boundary}--${CRLF}`, 'utf8');

  return { boundary, head, tail, length: head.length + input.fileSize + tail.length };
}

/**
 * The envelope and the file as one stream: head, every byte of the file, tail.
 *
 * `onProgress` sees file bytes only, not envelope bytes, so a progress bar
 * reaches 100% exactly when the file has gone.
 */
export function multipartStream(
  envelope: Envelope,
  file: Readable,
  onProgress?: (fileBytesSent: number) => void,
): Readable {
  let sent = 0;
  let headWritten = false;

  const body = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (!headWritten) {
        headWritten = true;
        this.push(envelope.head);
      }
      sent += chunk.length;
      onProgress?.(sent);
      callback(null, chunk);
    },
    flush(callback) {
      if (!headWritten) this.push(envelope.head); // an empty file still gets a head
      this.push(envelope.tail);
      callback();
    },
  });

  file.on('error', (error) => body.destroy(error));
  return file.pipe(body);
}

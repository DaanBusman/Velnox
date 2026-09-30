import { createHash } from 'node:crypto';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { createWriteStream } from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type BlockList, type LookupFunction } from 'node:net';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ERROR_CODES, displayUrl } from '@velnox/shared';
import { refusalFor } from './address-guard';
import { StepError } from '../jobs/steps';

/**
 * Fetch a file from a URL into the library, safely.
 *
 * See `address-guard.ts` for which addresses are reachable and why. The rest
 * of what makes this safe:
 *
 * - **http and https only**, and never from https down to http on a redirect —
 *   a mirror that bounces to plain HTTP has just handed the download to anyone
 *   on the path.
 * - **At most five redirects**, each one judged afresh: a public URL that
 *   redirects to 169.254.169.254 is refused at the redirect.
 * - **No credentials in the URL.** A `user:pass@` URL is refused rather than
 *   stored, because it would be stored.
 * - **Certificates verified** against the system trust store. There is no
 *   "ignore certificate" switch: a library file ends up installed on customer
 *   machines, and one fetched from an unverified host is one nobody can vouch
 *   for.
 * - **A byte limit**, enforced while the bytes arrive, not after.
 */

const MAX_REDIRECTS = 5;
const IDLE_TIMEOUT_MS = 60_000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export interface DownloadOptions {
  url: string;
  destination: string;
  signal: AbortSignal;
  blocked: BlockList;
  /** The most bytes accepted, whatever the server says. */
  maxBytes: number;
  userAgent: string;
  /**
   * Called once, when the final response's headers are in and before any byte
   * is written. Throw to refuse — this is where capacity is checked against
   * what the server says it will send.
   */
  onStart?(declaredBytes: number | null, finalUrl: string): Promise<void>;
  onProgress?(bytes: number): void;
}

export interface DownloadResult {
  bytes: number;
  sha256: string;
  declaredBytes: number | null;
}

const refused = (reason: string, url: string): StepError =>
  new StepError(ERROR_CODES.libraryUrlRefused, `Refused to fetch ${displayUrl(url)}: ${reason}`);

/**
 * A resolver that answers only with addresses the guard allows.
 *
 * Handed to the request as its `lookup`, so the address checked is the address
 * connected to. Any refused address in the answer refuses the whole name: a
 * name resolving to a public mirror *and* to 127.0.0.1 is not a mirror.
 */
function guardedLookup(blocked: BlockList): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(
      hostname,
      { all: true, family: options.family ?? 0 },
      (error, addresses: LookupAddress[]) => {
        if (error) {
          callback(error, '', 0);
          return;
        }
        for (const { address } of addresses) {
          const reason = refusalFor(address, blocked);
          if (reason) {
            callback(
              Object.assign(new Error(`${hostname} resolves to ${address}, ${reason}`), {
                code: 'VELNOX_REFUSED',
              }),
              '',
              0,
            );
            return;
          }
        }
        if (options.all) {
          (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses);
          return;
        }
        const first = addresses[0];
        if (!first) {
          callback(new Error(`${hostname} did not resolve`), '', 0);
          return;
        }
        callback(null, first.address, first.family);
      },
    );
  };
}

function open(url: URL, options: DownloadOptions): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'GET',
      headers: { 'user-agent': options.userAgent, accept: '*/*' },
      lookup: guardedLookup(options.blocked),
      // No agent: a pooled socket could have been resolved before the guard.
      agent: false,
      timeout: IDLE_TIMEOUT_MS,
    });
    const abort = () => request.destroy(new Error('Cancelled'));
    options.signal.addEventListener('abort', abort, { once: true });

    request.on('response', (response) => {
      options.signal.removeEventListener('abort', abort);
      resolve(response);
    });
    request.on('timeout', () => request.destroy(new Error('The server stopped answering')));
    request.on('error', (error: Error & { code?: string }) => {
      options.signal.removeEventListener('abort', abort);
      reject(error.code === 'VELNOX_REFUSED' ? refused(error.message, url.href) : error);
    });
    request.end();
  });
}

export async function downloadToFile(options: DownloadOptions): Promise<DownloadResult> {
  let current = new URL(options.url);

  for (let hop = 0; ; hop += 1) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      throw refused('only http and https are fetched', current.href);
    }
    if (current.username || current.password) {
      throw refused('credentials in a URL are not accepted', current.href);
    }
    // A literal address is never looked up, so the guard sees it here instead.
    const literal = current.hostname.replace(/^\[|\]$/g, '');
    if (isIP(literal)) {
      const reason = refusalFor(literal, options.blocked);
      if (reason) throw refused(reason, current.href);
    }

    const response = await open(current, options);
    const status = response.statusCode ?? 0;

    if (REDIRECTS.has(status)) {
      response.resume();
      const location = response.headers.location;
      if (!location)
        throw new StepError(ERROR_CODES.libraryUrlFailed, `HTTP ${status} without a Location`);
      if (hop + 1 > MAX_REDIRECTS) {
        throw new StepError(
          ERROR_CODES.libraryUrlTooManyRedirects,
          `More than ${MAX_REDIRECTS} redirects`,
        );
      }
      const next = new URL(location, current);
      if (current.protocol === 'https:' && next.protocol === 'http:') {
        throw refused('a redirect from https to plain http', next.href);
      }
      current = next;
      continue;
    }

    if (status !== 200) {
      response.resume();
      throw new StepError(
        ERROR_CODES.libraryUrlFailed,
        `HTTP ${status} from ${displayUrl(current.href)}`,
      );
    }

    const header = response.headers['content-length'];
    const declared = header !== undefined && /^\d+$/.test(header) ? Number(header) : null;

    // Capacity first: the caller refuses with the numbers an operator needs.
    try {
      await options.onStart?.(declared, current.href);
    } catch (error) {
      response.destroy();
      throw error;
    }
    // And a backstop, should a caller not check.
    if (declared !== null && declared > options.maxBytes) {
      response.destroy();
      throw new StepError(
        ERROR_CODES.libraryFull,
        `The server declared ${declared} bytes; the library can take ${options.maxBytes}`,
      );
    }

    const hash = createHash('sha256');
    let bytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > options.maxBytes || (declared !== null && bytes > declared)) {
          callback(
            new StepError(
              ERROR_CODES.librarySizeMismatch,
              declared !== null && bytes > declared
                ? `The server sent more than the ${declared} bytes it declared`
                : `The download passed the ${options.maxBytes} bytes the library can take`,
            ),
          );
          return;
        }
        hash.update(chunk);
        options.onProgress?.(bytes);
        callback(null, chunk);
      },
    });

    await pipeline(response, meter, createWriteStream(options.destination), {
      signal: options.signal,
    });

    if (declared !== null && bytes !== declared) {
      throw new StepError(
        ERROR_CODES.librarySizeMismatch,
        `The server declared ${declared} bytes and sent ${bytes}`,
      );
    }

    return { bytes, sha256: hash.digest('hex'), declaredBytes: declared };
  }
}

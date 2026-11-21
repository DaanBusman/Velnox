import { spawn } from 'node:child_process';
import { X509Certificate, createPrivateKey, type KeyObject } from 'node:crypto';
import type { Writable } from 'node:stream';
import { ERROR_CODES, VelnoxError } from '@velnox/shared';

/**
 * A PFX (PKCS#12) file, read into the PEM the rest of the path takes (0.7.29).
 *
 * Node cannot take one apart, so `openssl pkcs12` does, with a fixed argument
 * list and no shell. Nothing from the request is ever an argument: the file
 * goes in on stdin and its password on a separate descriptor, so neither is on
 * a command line, in the environment or in a temporary file. What openssl says
 * on stderr is only classified, never logged or returned.
 *
 * Windows has long exported PFX files with RC2 or 3DES, which OpenSSL 3 keeps
 * in its legacy provider: a file refused as unsupported is read again with it.
 */

const CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
const PRIVATE_KEY =
  /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]+?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----/g;
const TIMEOUT_MS = 15_000;

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

function openssl(args: readonly string[], pfx: Buffer, password: string): Promise<Outcome> {
  return new Promise((resolve) => {
    const child = spawn('openssl', ['pkcs12', ...args, '-passin', 'fd:3'], {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      timeout: TIMEOUT_MS,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.once('error', () => resolve({ code: -1, stdout: '', stderr: '' }));
    child.once('close', (code) =>
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      }),
    );
    // It may exit without reading either, on a file that is no PFX at all.
    const ignore = () => undefined;
    child.stdin.on('error', ignore);
    child.stdin.end(pfx);
    const passwordPipe = child.stdio[3] as Writable;
    passwordPipe.on('error', ignore);
    passwordPipe.end(`${password}\n`);
  });
}

/**
 * The leaf followed by its intermediates, in order. A PFX keeps its
 * certificates in no particular order, and a server must send them in one. The
 * root is left out: a browser has its own, and one sent along is ignored.
 */
export function orderChain(leaf: X509Certificate, others: readonly X509Certificate[]): string[] {
  const ordered = [leaf];
  const left = others.filter((c) => c.fingerprint256 !== leaf.fingerprint256);
  let current = leaf;
  for (;;) {
    if (current.issuer === current.subject) break;
    const index = left.findIndex((c) => current.checkIssued(c) && c.issuer !== c.subject);
    if (index < 0) break;
    current = left.splice(index, 1)[0]!;
    ordered.push(current);
  }
  return ordered.map((c) => c.toString().trim());
}

/** The certificate and unencrypted key in a PFX file, given as base64. */
export async function readPfx(
  base64: string,
  password: string,
): Promise<{ certificate: string; key: string }> {
  const pfx = Buffer.from(base64, 'base64');
  let legacy = false;
  const read = async (args: readonly string[]): Promise<string> => {
    let result = await openssl(legacy ? ['-legacy', ...args] : args, pfx, password);
    if (result.code !== 0 && !legacy && /unsupported/i.test(result.stderr)) {
      legacy = true;
      result = await openssl(['-legacy', ...args], pfx, password);
    }
    if (result.code === 0) return result.stdout;
    if (/mac verify|invalid password/i.test(result.stderr)) {
      throw new VelnoxError(ERROR_CODES.tlsPfxPassword, { status: 400 });
    }
    throw new VelnoxError(ERROR_CODES.tlsPfxInvalid, { status: 400 });
  };

  const certificatePems = (await read(['-nokeys'])).match(CERTIFICATE) ?? [];
  const keyPems = (await read(['-nocerts', '-nodes'])).match(PRIVATE_KEY) ?? [];

  let certificates: X509Certificate[];
  let keys: { pem: string; object: KeyObject }[];
  try {
    certificates = certificatePems.map((pem) => new X509Certificate(pem));
    keys = keyPems.map((pem) => ({ pem, object: createPrivateKey({ key: pem, format: 'pem' }) }));
  } catch {
    throw new VelnoxError(ERROR_CODES.tlsPfxInvalid, { status: 400 });
  }

  // The leaf is the certificate a key in the file belongs to.
  for (const key of keys) {
    const leaf = certificates.find((c) => c.checkPrivateKey(key.object));
    if (leaf) {
      return {
        certificate: `${orderChain(leaf, certificates).join('\n')}\n`,
        key: `${key.pem}\n`,
      };
    }
  }
  throw new VelnoxError(ERROR_CODES.tlsPfxInvalid, { status: 400 });
}

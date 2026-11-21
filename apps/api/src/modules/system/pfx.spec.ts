import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@velnox/shared';
import { readPfx } from './pfx';

/** Certificates are made for the test with openssl, never kept in the source. */
const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const dir = mkdtempSync(join(tmpdir(), 'velnox-pfx-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PASSWORD = 'test only, with spaces & $igns';
const run = (args: string[]) =>
  execFileSync('openssl', args, {
    stdio: 'ignore',
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });
const path = (name: string) => join(dir, name);

function issue(name: string, subject: string, issuer: string | null, ca: boolean) {
  run([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    path(`${name}.key`),
    '-out',
    path(`${name}.crt`),
    '-days',
    '30',
    '-subj',
    `/CN=${subject}`,
    '-addext',
    ca ? 'basicConstraints=critical,CA:TRUE' : `subjectAltName=DNS:${subject}`,
    ...(issuer ? ['-CA', path(`${issuer}.crt`), '-CAkey', path(`${issuer}.key`)] : []),
  ]);
}

function pfx(name: string, extra: string[] = []) {
  // Root before intermediate on purpose: a PFX promises no order.
  writeFileSync(
    path('others.pem'),
    readFileSync(path('root.crt'), 'utf8') + readFileSync(path('intermediate.crt'), 'utf8'),
  );
  run([
    'pkcs12',
    '-export',
    '-inkey',
    path('leaf.key'),
    '-in',
    path('leaf.crt'),
    '-certfile',
    path('others.pem'),
    '-passout',
    `pass:${PASSWORD}`,
    '-out',
    path(`${name}.pfx`),
    ...extra,
  ]);
  return readFileSync(path(`${name}.pfx`)).toString('base64');
}

const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'no error',
    (error: { code?: string }) => error.code,
  );

describe.skipIf(!hasOpenssl)('readPfx', () => {
  if (hasOpenssl) {
    issue('root', 'Test Root', null, true);
    issue('intermediate', 'Test Intermediate', 'root', true);
    issue('leaf', 'velnox.example.com', 'intermediate', false);
  }
  const modern = hasOpenssl ? pfx('modern') : '';
  const old = hasOpenssl
    ? pfx('old', ['-legacy', '-certpbe', 'PBE-SHA1-RC2-40', '-keypbe', 'PBE-SHA1-3DES', '-macalg', 'sha1'])
    : '';

  it('gives the leaf, then its intermediate, without the root', async () => {
    const { certificate } = await readPfx(modern, PASSWORD);
    const blocks = certificate.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)!;
    expect(blocks.map((b) => new X509Certificate(b).subject.trim())).toEqual([
      'CN=velnox.example.com',
      'CN=Test Intermediate',
    ]);
  });

  it('gives the key that belongs to the leaf, unencrypted', async () => {
    const { certificate, key } = await readPfx(modern, PASSWORD);
    expect(key).toContain('BEGIN PRIVATE KEY');
    expect(new X509Certificate(certificate).checkPrivateKey(
      (await import('node:crypto')).createPrivateKey(key),
    )).toBe(true);
  });

  it('reads a file exported the old way, as Windows long did', async () => {
    const { certificate } = await readPfx(old, PASSWORD);
    expect(new X509Certificate(certificate).subject.trim()).toBe('CN=velnox.example.com');
  });

  it('says so when the password is wrong', async () => {
    expect(await codeOf(readPfx(modern, 'not it'))).toBe(ERROR_CODES.tlsPfxPassword);
    expect(await codeOf(readPfx(old, 'not it'))).toBe(ERROR_CODES.tlsPfxPassword);
  });

  it('says so when it is no PFX at all', async () => {
    const notOne = Buffer.from('this is not a certificate').toString('base64');
    expect(await codeOf(readPfx(notOne, PASSWORD))).toBe(ERROR_CODES.tlsPfxInvalid);
  });

  it('refuses a file with no key in it', async () => {
    run([
      'pkcs12',
      '-export',
      '-nokeys',
      '-in',
      path('leaf.crt'),
      '-passout',
      `pass:${PASSWORD}`,
      '-out',
      path('nokey.pfx'),
    ]);
    const noKey = readFileSync(path('nokey.pfx')).toString('base64');
    expect(await codeOf(readPfx(noKey, PASSWORD))).toBe(ERROR_CODES.tlsPfxInvalid);
  });
});

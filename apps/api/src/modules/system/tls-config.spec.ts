import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkCertificate, directiveFor } from './tls-config.service';

/** Certificates are made for the test with openssl, never kept in the source. */
const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const dir = mkdtempSync(join(tmpdir(), 'velnox-tls-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function selfSigned(name: string, san: string) {
  const key = join(dir, `${name}.key`);
  const crt = join(dir, `${name}.crt`);
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      crt,
      '-days',
      '30',
      '-subj',
      `/CN=${san}`,
      '-addext',
      `subjectAltName=DNS:${san}`,
    ],
    { stdio: 'ignore', env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
  );
  return { key: readFileSync(key, 'utf8'), certificate: readFileSync(crt, 'utf8') };
}

describe.skipIf(!hasOpenssl)('checkCertificate', () => {
  const a = hasOpenssl ? selfSigned('a', 'velnox.example.com') : { key: '', certificate: '' };
  const b = hasOpenssl ? selfSigned('b', 'other.example.com') : { key: '', certificate: '' };

  it('accepts a certificate with its own key, and normalises the key to PKCS#8', () => {
    const checked = checkCertificate(a.certificate, a.key, 'velnox.example.com');
    expect(checked.key).toContain('-----BEGIN PRIVATE KEY-----');
    expect(checked.certificate).not.toContain('PRIVATE KEY');
    expect(checked.warnings).toEqual([]);
  });

  it('refuses a key that belongs to another certificate', () => {
    expect(() => checkCertificate(a.certificate, b.key, 'velnox.example.com')).toThrow(
      expect.objectContaining({ code: 'tls.key_mismatch' }),
    );
  });

  it('refuses what is not a certificate, or not a key', () => {
    expect(() => checkCertificate('hello', a.key, 'x')).toThrow(
      expect.objectContaining({ code: 'tls.certificate_invalid' }),
    );
    expect(() => checkCertificate(a.certificate, 'hello', 'x')).toThrow(
      expect.objectContaining({ code: 'tls.key_invalid' }),
    );
  });

  it('refuses a certificate that has expired', () => {
    const later = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000);
    expect(() => checkCertificate(a.certificate, a.key, 'velnox.example.com', later)).toThrow(
      expect.objectContaining({ code: 'tls.certificate_expired' }),
    );
  });

  it('warns, and does not refuse, when the names do not cover the address', () => {
    expect(checkCertificate(a.certificate, a.key, 'elsewhere.example.org').warnings).toContain(
      'tls.warning_not_covering',
    );
  });

  it('never puts a private key among the certificates it keeps', () => {
    const smuggled = `${a.certificate}\n${a.key}`;
    expect(checkCertificate(smuggled, a.key, 'velnox.example.com').certificate).not.toContain(
      'PRIVATE KEY',
    );
  });
});

describe('directiveFor', () => {
  const none = {
    acmeEmail: null,
    acmeDirectory: null,
    acmeCaRoot: null,
    certificatePem: null,
    keyPem: null,
  };

  it('hands back to the installer by importing its file', () => {
    expect(directiveFor({ ...none, mode: null })).toContain('import /etc/caddy/tls/tls.caddy');
  });

  it('writes each mode as one tls directive', () => {
    expect(directiveFor({ ...none, mode: 'INTERNAL' })).toMatch(/^tls internal$/m);
    expect(directiveFor({ ...none, mode: 'CERTIFICATE' })).toMatch(
      /^tls \/etc\/caddy\/managed\/velnox\.crt \/etc\/caddy\/managed\/velnox\.key$/m,
    );
    expect(directiveFor({ ...none, mode: 'ACME', acmeEmail: 'ops@example.com' })).toMatch(
      /^tls ops@example\.com$/m,
    );
  });

  it('names another ACME directory and its root when there is one', () => {
    const text = directiveFor({
      ...none,
      mode: 'ACME',
      acmeEmail: 'ops@example.com',
      acmeDirectory: 'https://acme.internal/dir',
      acmeCaRoot: 'PEM',
    });
    expect(text).toContain('\tca https://acme.internal/dir\n');
    expect(text).toContain('\tca_root /etc/caddy/managed/acme-ca.pem\n');
  });
});

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { BlockList, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildBlockList } from './address-guard';
import { downloadToFile } from './fetch';

/*
 * Against a real HTTP server on loopback. The guard refuses loopback, so most
 * of these run with an empty block list — they test redirects, sizes and
 * checksums, not addresses — and one runs with the real list to prove the
 * guard is actually in the path.
 */

const ISO = Buffer.alloc(40_000, 7);
let server: Server;
let base: string;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'velnox-fetch-'));
  server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/a.iso') {
      res.writeHead(200, { 'content-length': ISO.length });
      res.end(ISO);
    } else if (url === '/hop') {
      res.writeHead(302, { location: '/a.iso' });
      res.end();
    } else if (url.startsWith('/loop')) {
      res.writeHead(302, { location: `/loop${Number(url.slice(5) || 0) + 1}` });
      res.end();
    } else if (url === '/short') {
      // Declares more than it sends, then ends: a truncated download.
      res.writeHead(200, { 'content-length': ISO.length + 100 });
      res.end(ISO);
    } else if (url === '/unsized') {
      res.writeHead(200);
      res.end(ISO);
    } else if (url === '/to-metadata') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    } else {
      res.writeHead(404);
      res.end('not here');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

const open = new BlockList();
const fetchTo = (url: string, extra: Partial<Parameters<typeof downloadToFile>[0]> = {}) =>
  downloadToFile({
    url,
    destination: join(dir, `f-${Math.random()}`),
    signal: new AbortController().signal,
    blocked: open,
    maxBytes: 10_000_000,
    userAgent: 'velnox-test',
    ...extra,
  });

describe('fetching a file into the library', () => {
  it('writes every byte and returns their checksum', async () => {
    const destination = join(dir, 'ok.iso');
    const result = await fetchTo(`${base}/a.iso`, { destination });
    expect(result).toEqual({
      bytes: ISO.length,
      sha256: createHash('sha256').update(ISO).digest('hex'),
      declaredBytes: ISO.length,
    });
    expect(readFileSync(destination).equals(ISO)).toBe(true);
  });

  it('follows a redirect', async () => {
    expect((await fetchTo(`${base}/hop`)).bytes).toBe(ISO.length);
  });

  it('gives up after five redirects', async () => {
    await expect(fetchTo(`${base}/loop0`)).rejects.toMatchObject({
      code: 'library.url_too_many_redirects',
    });
  });

  it('refuses a non-200 answer, and says what it was', async () => {
    await expect(fetchTo(`${base}/missing.iso`)).rejects.toMatchObject({
      code: 'library.url_failed',
    });
  });

  it('refuses a download that ends short of what it declared', async () => {
    await expect(fetchTo(`${base}/short`)).rejects.toBeTruthy();
  });

  it('stops at the byte limit even when the server declares nothing', async () => {
    await expect(fetchTo(`${base}/unsized`, { maxBytes: 1000 })).rejects.toMatchObject({
      code: 'library.size_mismatch',
    });
  });

  it('lets the caller refuse on the declared size before a byte is written', async () => {
    let seen: number | null = -1;
    await expect(
      fetchTo(`${base}/a.iso`, {
        onStart: async (declared) => {
          seen = declared;
          throw new Error('library full');
        },
      }),
    ).rejects.toThrow('library full');
    expect(seen).toBe(ISO.length);
  });

  it.each([
    ['a scheme that is not http', 'ftp://example.com/a.iso'],
    ['a file URL', 'file:///etc/passwd'],
    ['credentials in the URL', 'https://user:pass@example.com/a.iso'],
  ])('refuses %s', async (_why, url) => {
    await expect(fetchTo(url)).rejects.toMatchObject({ code: 'library.url_refused' });
  });

  it('stops when the job is cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(fetchTo(`${base}/a.iso`, { signal: controller.signal })).rejects.toBeTruthy();
  });
});

describe('the address guard is in the path', () => {
  const guarded = buildBlockList({ ownNetworks: [] });

  it('refuses loopback given as a literal address', async () => {
    await expect(fetchTo(`${base}/a.iso`, { blocked: guarded })).rejects.toMatchObject({
      code: 'library.url_refused',
    });
  });

  it('refuses loopback reached through a name', async () => {
    const port = (server.address() as AddressInfo).port;
    await expect(
      fetchTo(`http://localhost:${port}/a.iso`, { blocked: guarded }),
    ).rejects.toMatchObject({
      code: 'library.url_refused',
    });
  });

  it('refuses a redirect to the metadata service, at the redirect', async () => {
    // The first hop is allowed only because this test opens loopback; the
    // second hop is judged with the full list and refused.
    const loopbackOnly = new BlockList();
    loopbackOnly.addSubnet('169.254.0.0', 16);
    await expect(fetchTo(`${base}/to-metadata`, { blocked: loopbackOnly })).rejects.toMatchObject({
      code: 'library.url_refused',
    });
  });
});

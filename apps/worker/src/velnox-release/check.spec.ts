import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readManifest } from './check';

/* Against a real HTTP server on loopback: what the worker does with each answer. */

let server: Server;
let base = '';
let seenHeaders: Record<string, string | string[] | undefined> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    seenHeaders = req.headers;
    switch (req.url) {
      case '/release.json':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ version: '0.7.30', advisories: [] }));
        return;
      case '/portal':
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html>Sign in to the guest Wi-Fi</html>');
        return;
      case '/wrong':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ version: 'latest' }));
        return;
      case '/huge':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(`{"version":"0.7.30","pad":"${'x'.repeat(300 * 1024)}"}`);
        return;
      case '/slow':
        setTimeout(() => res.end('{}'), 2_000);
        return;
      default:
        res.writeHead(404);
        res.end('not here');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe('readManifest', () => {
  it('reads the file, and sends nothing about the installation', async () => {
    expect(await readManifest(`${base}/release.json`)).toEqual({
      ok: true,
      manifest: { version: '0.7.30', advisories: [] },
    });
    expect(seenHeaders['user-agent']).toBe('Velnox update check');
    expect(Object.keys(seenHeaders).some((h) => /instance|version|tenant/i.test(h))).toBe(false);
  });

  it('says a page that is not the file is not the file', async () => {
    expect(await readManifest(`${base}/portal`)).toMatchObject({ ok: false, error: 'invalid' });
    expect(await readManifest(`${base}/wrong`)).toMatchObject({ ok: false, error: 'invalid' });
  });

  it('names the HTTP status of a miss', async () => {
    expect(await readManifest(`${base}/gone`)).toEqual({ ok: false, error: 'http', detail: 'HTTP 404' });
  });

  it('stops reading at the ceiling', async () => {
    expect(await readManifest(`${base}/huge`)).toMatchObject({ ok: false, error: 'too_large' });
  });

  it('gives up on a server that does not answer', async () => {
    expect(await readManifest(`${base}/slow`, 300)).toMatchObject({ ok: false, error: 'timeout' });
  });

  it('says when nothing answers at all', async () => {
    expect(await readManifest('http://127.0.0.1:1/release.json')).toMatchObject({
      ok: false,
      error: 'network',
    });
  });
});

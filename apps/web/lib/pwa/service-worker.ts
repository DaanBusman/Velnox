/**
 * The service worker that makes Velnox installable (ADR-058), as source text.
 *
 * What it caches is the whole point, so it is short enough to read in one go:
 *
 * - **`/_next/static/*`, cache first.** Next names every file there by its
 *   content hash, so a cached copy can never be stale — a new build asks for
 *   new names. The manifest's icons are imported assets and live there too.
 * - **A page navigation, network only.** When the network fails, a page that
 *   says so — written here, with no data in it — instead of the browser's.
 * - **Everything else, untouched.** The API, the pages' data and Next's RSC
 *   payloads go to the network exactly as without a service worker. Velnox is
 *   multi-tenant and used on shared workstations: no customer's data may stay
 *   behind on a disk, so none is ever put in a cache.
 *
 * The cache is named after the build. A new build is a new service worker
 * (its text differs), which on activating removes the caches of the old one.
 * Signing out removes them too (`clearAppCaches`).
 *
 * Plain JavaScript for the browser, not bundled: it runs outside the page.
 * The test evaluates this very text, so what is tested is what ships.
 */

export interface OfflineText {
  lang: string;
  title: string;
  body: string;
  retry: string;
}

export const CACHE_PREFIX = 'velnox-';

export function serviceWorkerSource(build: string, offline: readonly OfflineText[]): string {
  return `'use strict';
const STATIC = ${JSON.stringify(`${CACHE_PREFIX}static-${build}`)};
const OFFLINE = ${JSON.stringify(offline)};

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith(${JSON.stringify(CACHE_PREFIX)}) && key !== STATIC) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(fromCache(request));
    return;
  }
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(offlinePage));
  }
  // Anything else is not answered here: the browser fetches it as it would
  // without a service worker, and nothing of it is stored.
});

async function fromCache(request) {
  const cache = await caches.open(STATIC);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok && response.type === 'basic') await cache.put(request, response.clone());
  return response;
}

function offlinePage() {
  const language = String((self.navigator && self.navigator.language) || 'en').toLowerCase();
  const text = OFFLINE.find((t) => language.startsWith(t.lang)) || OFFLINE[0];
  const escape = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const html = '<!doctype html><html lang="' + escape(text.lang) + '"><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + escape(text.title) + '</title>' +
    '<style>body{font:14px system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;' +
    'background:#0a0e13;color:#e6e9ef}main{max-width:28rem;padding:1.5rem}h1{font-size:1.1rem}' +
    'a{color:#4c94f7}</style>' +
    '<main><h1>' + escape(text.title) + '</h1><p>' + escape(text.body) + '</p>' +
    '<p><a href="">' + escape(text.retry) + '</a></p></main></html>';
  return new Response(html, {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}
`;
}

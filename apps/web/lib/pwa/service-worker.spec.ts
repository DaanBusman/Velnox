import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { serviceWorkerSource } from './service-worker';

/**
 * The service worker's text, run as the browser would run it, with the
 * network and Cache Storage replaced by records of what was asked of them.
 * The promise under test: nothing but `/_next/static` is ever stored.
 */
const ORIGIN = 'https://velnox.example';
const offline = [
  { lang: 'en', title: 'Unreachable', body: 'No connection <now>.', retry: 'Retry' },
  { lang: 'nl', title: 'Onbereikbaar', body: 'Geen verbinding.', retry: 'Opnieuw' },
];

function worker(build = '1.0.0-abc', options: { network?: 'up' | 'down'; language?: string } = {}) {
  const listeners: Record<string, (event: unknown) => void> = {};
  const stores = new Map<string, Map<string, Response>>();
  const fetched: string[] = [];
  const caches = {
    keys: async () => [...stores.keys()],
    delete: async (key: string) => stores.delete(key),
    open: async (key: string) => {
      if (!stores.has(key)) stores.set(key, new Map());
      const store = stores.get(key)!;
      return {
        match: async (r: Request) => store.get(r.url),
        put: async (r: Request, response: Response) => void store.set(r.url, response),
      };
    },
  };
  const self = {
    location: { origin: ORIGIN },
    navigator: { language: options.language ?? 'en-GB' },
    clients: { claim: async () => {} },
    skipWaiting: () => {},
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners[type] = listener;
    },
  };
  const fetch = async (request: Request) => {
    fetched.push(request.url);
    if (options.network === 'down') throw new TypeError('Failed to fetch');
    // What a same-origin answer is to the worker: `basic`, which a real
    // Response built here cannot be.
    const answer = {
      ok: true,
      status: 200,
      type: 'basic',
      text: async () => `body of ${request.url}`,
      clone: () => answer,
    };
    return answer;
  };
  runInNewContext(serviceWorkerSource(build, offline), {
    self,
    caches,
    fetch,
    Response,
    URL,
    String,
  });

  /** A fetch as the browser dispatches it: what the worker answered, or null. */
  const request = async (path: string, init: { mode?: string; method?: string } = {}) => {
    const answered: { response?: Promise<Response> } = {};
    const url = path.startsWith('http') ? path : `${ORIGIN}${path}`;
    listeners.fetch!({
      request: { url, method: init.method ?? 'GET', mode: init.mode ?? 'cors' },
      respondWith: (r: Promise<Response>) => (answered.response = r),
    });
    return answered.response ? await answered.response : null;
  };
  const activate = async () => {
    let done: Promise<unknown> = Promise.resolve();
    listeners.activate!({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
  };
  return { request, activate, stores, fetched, caches };
}

describe('the service worker', () => {
  it('keeps the static files Next names by their content, and answers them from the cache', async () => {
    const sw = worker();
    const first = await sw.request('/_next/static/chunks/app-1a2b.js');
    expect(await first!.text()).toContain('app-1a2b.js');
    await sw.request('/_next/static/chunks/app-1a2b.js');
    expect(sw.fetched).toEqual([`${ORIGIN}/_next/static/chunks/app-1a2b.js`]);
    expect([...sw.stores.keys()]).toEqual(['velnox-static-1.0.0-abc']);
  });

  it('never answers or stores the API, page data, or anything not static', async () => {
    const sw = worker();
    for (const path of [
      '/api/v1/clusters',
      '/api/v1/auth/me',
      '/clusters?_rsc=1x2y',
      '/manifest.webmanifest',
      '/sw.js',
      'https://elsewhere.example/_next/static/x.js',
    ]) {
      expect(await sw.request(path), path).toBeNull();
    }
    expect(await sw.request('/_next/static/x.js', { method: 'POST' })).toBeNull();
    expect(sw.stores.size).toBe(0);
  });

  it('fetches a page from the network, storing nothing', async () => {
    const sw = worker();
    const page = await sw.request('/clusters', { mode: 'navigate' });
    expect(await page!.text()).toContain('/clusters');
    expect(sw.stores.size).toBe(0);
  });

  it('says it cannot reach the server when the network is down, in the viewer’s language', async () => {
    const sw = worker('1', { network: 'down', language: 'nl-NL' });
    const page = await sw.request('/clusters', { mode: 'navigate' });
    expect(page!.status).toBe(503);
    expect(await page!.text()).toContain('Onbereikbaar');

    const english = await worker('1', { network: 'down' }).request('/', { mode: 'navigate' });
    expect(await english!.text()).toContain('No connection &lt;now&gt;.');
  });

  it('removes the caches of an older build when it takes over, and only those', async () => {
    const sw = worker('2.0.0-def');
    await sw.caches.open('velnox-static-1.0.0-abc');
    await sw.caches.open('velnox-static-2.0.0-def');
    await sw.caches.open('someone-else');
    await sw.activate();
    expect([...sw.stores.keys()].sort()).toEqual(['someone-else', 'velnox-static-2.0.0-def']);
  });
});

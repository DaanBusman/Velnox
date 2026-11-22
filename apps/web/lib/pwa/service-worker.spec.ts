import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { serviceWorkerSource } from './service-worker';

/**
 * The service worker's text, run as the browser would run it, with the
 * network and Cache Storage replaced by records of what was asked of them.
 * The promise under test: nothing but `/_next/static` is ever stored.
 */
const ORIGIN = 'https://velnox.example';
const JOB = '3f2a7c1e-9b4d-4e21-8c55-0a1b2c3d4e5f';
const notices = [
  {
    lang: 'en',
    approvalTitle: 'Approval needed',
    approvalBody: 'A job is waiting.',
    testTitle: 'It works',
    testBody: 'Test.',
    proceed: 'Continue',
    cancel: 'Cancel',
  },
  {
    lang: 'nl',
    approvalTitle: 'Goedkeuring nodig',
    approvalBody: 'Een taak wacht.',
    testTitle: 'Het werkt',
    testBody: 'Test.',
    proceed: 'Doorgaan',
    cancel: 'Annuleren',
  },
];

const offline = [
  { lang: 'en', title: 'Unreachable', body: 'No connection <now>.', retry: 'Retry' },
  { lang: 'nl', title: 'Onbereikbaar', body: 'Geen verbinding.', retry: 'Opnieuw' },
];

function worker(build = '1.0.0-abc', options: { network?: 'up' | 'down'; language?: string } = {}) {
  const listeners: Record<string, (event: unknown) => void> = {};
  const stores = new Map<string, Map<string, Response>>();
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const windows: { url: string; focus: () => Promise<void> }[] = [];
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
    clients: {
      claim: async () => {},
      matchAll: async () => windows,
      openWindow: async (url: string) => void opened.push(url),
    },
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) =>
        void shown.push({ title, options }),
    },
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
  runInNewContext(serviceWorkerSource(build, offline, notices, '/_next/static/media/icon.png'), {
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
  const push = async (message: unknown) => {
    let done: Promise<unknown> = Promise.resolve();
    listeners.push!({
      data:
        message === undefined
          ? null
          : {
              json: () => {
                if (message === 'broken') throw new SyntaxError('not JSON');
                return message;
              },
            },
      waitUntil: (p: Promise<unknown>) => (done = p),
    });
    await done;
  };
  const click = async (data: unknown, action = '') => {
    let closed = false;
    let done: Promise<unknown> = Promise.resolve();
    listeners.notificationclick!({
      action,
      notification: { data, close: () => (closed = true) },
      waitUntil: (p: Promise<unknown>) => (done = p),
    });
    await done;
    return closed;
  };
  return { request, activate, stores, fetched, caches, push, click, shown, opened, windows };
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

  it('shows an approval in the language of the device, naming nothing about the job', async () => {
    const sw = worker();
    await sw.push({ v: 1, kind: 'approval', jobId: JOB, lang: 'nl' });
    expect(sw.shown).toHaveLength(1);
    expect(sw.shown[0]!.title).toBe('Goedkeuring nodig');
    expect(sw.shown[0]!.options).toMatchObject({
      body: 'Een taak wacht.',
      tag: `velnox-approval-${JOB}`,
      data: { jobId: JOB },
      actions: [
        { action: 'approve', title: 'Doorgaan' },
        { action: 'reject', title: 'Annuleren' },
      ],
    });
  });

  it('shows none of what a message says, and takes no address from it', async () => {
    const sw = worker();
    await sw.push({
      kind: 'approval',
      jobId: '../../evil',
      title: 'Click me',
      body: 'Click me',
      url: 'https://evil.example/',
      lang: 'xx',
    });
    expect(JSON.stringify(sw.shown)).not.toMatch(/Click me|evil/);
    expect(sw.shown[0]!.options.actions).toBeUndefined();
  });

  it.each([undefined, 'broken'])('still shows something for an unreadable message (%s)', async (message) => {
    const sw = worker();
    await sw.push(message);
    expect(sw.shown).toHaveLength(1);
  });

  it('opens the job, and a button only says which one was pressed', async () => {
    const sw = worker();
    expect(await sw.click({ jobId: JOB })).toBe(true);
    await sw.click({ jobId: JOB }, 'approve');
    await sw.click({ jobId: JOB }, 'reject');
    await sw.click({ jobId: JOB }, 'something-else');
    expect(sw.opened).toEqual([
      `${ORIGIN}/jobs/${JOB}`,
      `${ORIGIN}/jobs/${JOB}?decide=approve`,
      `${ORIGIN}/jobs/${JOB}?decide=reject`,
      `${ORIGIN}/jobs/${JOB}`,
    ]);
    // A click reaches no API: deciding takes the signed-in page.
    expect(sw.fetched).toEqual([]);
  });

  it('opens nothing but its own pages', async () => {
    const sw = worker();
    await sw.click({ jobId: 'https://evil.example/' }, 'approve');
    await sw.click(null);
    expect(sw.opened).toEqual([`${ORIGIN}/`, `${ORIGIN}/`]);
  });

  it('brings a window already on the job forward, and leaves other windows alone', async () => {
    const sw = worker();
    let focused = 0;
    sw.windows.push(
      { url: `${ORIGIN}/clusters`, focus: async () => void (focused -= 100) },
      { url: `${ORIGIN}/jobs/${JOB}`, focus: async () => void (focused += 1) },
    );
    await sw.click({ jobId: JOB });
    expect(focused).toBe(1);
    expect(sw.opened).toEqual([]);
  });
});

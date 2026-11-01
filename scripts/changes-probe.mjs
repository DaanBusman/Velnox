// Drives a headless Chromium over the DevTools protocol for verify-changes.sh
// and prints what it saw as one JSON object: how often an open screen re-reads
// with the change stream, and without it. No dependencies: Node's own fetch and
// WebSocket.
//
//   node scripts/changes-probe.mjs <devtools http address> <site> <cookies.json>
//
// The cookies are the session the harness signed in with through the API, so
// no password is ever typed into the browser.

const [devtools, site, cookieFile] = process.argv.slice(2);
const { readFile } = await import('node:fs/promises');
const cookies = JSON.parse(await readFile(cookieFile, 'utf8'));

const version = await (await fetch(`${devtools}/json/version`)).json();
const socket = new WebSocket(version.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, devtools.replace(/^http/, 'ws')));
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});

let nextId = 0;
const pending = new Map();
const waiters = [];
const requests = [];
socket.onmessage = (message) => {
  const data = JSON.parse(message.data);
  if (data.id !== undefined) {
    const p = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) p.reject(new Error(`${p.method}: ${data.error.message}`));
    else p.resolve(data.result);
    return;
  }
  if (data.method === 'Network.requestWillBeSent') {
    const { request } = data.params;
    const headers = Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), v]));
    requests.push({ at: Date.now(), url: new URL(request.url), rsc: headers.rsc === '1' });
  }
  for (const w of [...waiters]) if (w.method === data.method && w.session === data.sessionId) w.resolve(data.params);
};
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject, method });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
const once = (method, session, timeoutMs = 30_000) =>
  new Promise((resolve, reject) => {
    const w = { method, session, resolve: (p) => (waiters.splice(waiters.indexOf(w), 1), resolve(p)) };
    waiters.push(w);
    setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), timeoutMs);
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let s;
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, s);
  if (r.exceptionDetails) throw new Error(`${expression.slice(0, 60)}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
};
const navigate = async (path) => {
  const loaded = once('Page.loadEventFired', s);
  await send('Page.navigate', { url: `${site}${path}` }, s);
  await loaded;
};

// What was asked for since `from`: re-reads of the jobs page, reads of the
// running-jobs bar's list, and change streams opened.
const since = (from) => {
  const after = requests.filter((r) => r.at >= from);
  return {
    refreshes: after.filter((r) => r.rsc && r.url.pathname === '/jobs').length,
    jobLists: after.filter((r) => r.url.pathname === '/api/v1/jobs' && r.url.searchParams.get('active') === 'true').length,
    streams: after.filter((r) => r.url.pathname === '/api/v1/changes').length,
  };
};
const firstRefreshAfter = async (from, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = requests.find((r) => r.at >= from && r.rsc && r.url.pathname === '/jobs');
    if (hit) return hit.at - from;
    await sleep(100);
  }
  return null;
};

const IDLE_MS = 20_000;
const result = { idleSeconds: IDLE_MS / 1000 };
try {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  ({ sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true }));
  await send('Page.enable', {}, s);
  await send('Network.enable', {}, s);
  for (const c of cookies) await send('Network.setCookie', { ...c, url: site }, s);
  // Refresh every two seconds: the most eager setting, and the default.
  await send('Network.setCookie', { name: 'velnox_refresh', value: '2', path: '/', secure: true, url: site }, s);

  // An open screen with nothing happening.
  const opened = Date.now();
  await navigate('/jobs');
  result.signedIn = !(await evaluate('location.pathname')).startsWith('/login');
  await sleep(4_000);
  result.streamsOnOpen = since(opened).streams;
  const idleFrom = Date.now();
  await sleep(IDLE_MS);
  result.idle = since(idleFrom);

  // Something happens: a self-test job, started from the page as a user would.
  const jobFrom = Date.now();
  result.job = await evaluate(`(async () => {
    const csrf = document.cookie.split('; ').find((c) => c.startsWith('velnox_csrf='))?.slice(12) ?? '';
    const r = await fetch('/api/v1/jobs/selftest', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-velnox-csrf': csrf },
      body: JSON.stringify({ lane: 'changes-probe', steps: 4, secondsPerStep: 2 }),
    });
    const body = await r.json();
    return { status: r.status, id: body.id ?? null };
  })()`);
  result.refreshAfterJobMs = await firstRefreshAfter(jobFrom, 10_000);
  await sleep(12_000);
  result.whileRunning = since(jobFrom);
  result.jobShown = result.job.id
    ? await evaluate(`document.querySelectorAll('a[href="/jobs/${result.job.id}"]').length > 0`)
    : false;

  // No stream: the API refuses it, as it would a lost connection. The screen
  // goes back to its interval.
  await send('Network.setBlockedURLs', { urls: ['*/api/v1/changes*'] }, s);
  await navigate('/jobs');
  await sleep(14_000);
  const fallbackFrom = Date.now();
  await sleep(12_000);
  result.fallbackSeconds = 12;
  result.fallback = since(fallbackFrom);
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
}
process.stdout.write(JSON.stringify(result));
socket.close();
process.exit(0);

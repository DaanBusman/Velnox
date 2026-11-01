// Drives a headless Chromium over the DevTools protocol for verify-pwa.sh and
// prints what it saw as one JSON object. No dependencies: Node's own fetch and
// WebSocket.
//
//   node scripts/pwa-probe.mjs <devtools http address> <site> <cookies.json> <sign-out label> <install label>
//
// The cookies are the session the harness signed in with through the API, so
// no password is ever typed into the browser.

const [devtools, site, cookieFile, signOutLabel, installLabel] = process.argv.slice(2);
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
socket.onmessage = (message) => {
  const data = JSON.parse(message.data);
  if (data.id !== undefined) {
    const p = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) p.reject(new Error(`${p.method}: ${data.error.message}`));
    else p.resolve(data.result);
  } else {
    for (const w of [...waiters]) if (w.method === data.method && w.session === data.sessionId) w.resolve(data.params);
  }
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
const until = async (expression, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression).catch(() => false)) return true;
    await sleep(250);
  }
  return false;
};
const cacheEntries = `(async () => {
  const out = [];
  for (const key of await caches.keys()) {
    const cache = await caches.open(key);
    for (const r of await cache.keys()) out.push(key + ' ' + new URL(r.url).pathname);
  }
  return out;
})()`;

const result = {};
try {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  ({ sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true }));
  await send('Page.enable', {}, s);
  await send('Network.enable', {}, s);
  for (const c of cookies) await send('Network.setCookie', { ...c, url: site }, s);
  await navigate('/');
  result.signedIn = !(await evaluate('location.pathname')).startsWith('/login');
  result.workerActive = await until(
    `navigator.serviceWorker.ready.then((r) => r.active && r.active.state === 'activated')`,
  );
  // The worker controls what is loaded after it took over: a reload, then
  // screens visited as a user would, each with its own data and RSC payloads.
  await navigate('/');
  result.controlled = await evaluate('navigator.serviceWorker.controller !== null');
  for (const path of ['/clusters', '/jobs', '/updates', '/audit-log']) await navigate(path);
  await evaluate(`fetch('/api/v1/auth/me').then((r) => r.status)`);
  await evaluate(`fetch(location.pathname + '?_rsc=probe', { headers: { RSC: '1' } }).then((r) => r.status)`);
  result.cached = await evaluate(cacheEntries);

  const installability = await send('Page.getInstallabilityErrors', {}, s);
  result.installabilityErrors = installability.installabilityErrors.map((e) => e.errorId);
  const manifest = await send('Page.getAppManifest', {}, s);
  result.manifestErrors = manifest.errors.map((e) => e.message);

  // The browser's offer, as Edge and Chrome send it, and the menu's button.
  result.installButton = await evaluate(`(async () => {
    const offer = new Event('beforeinstallprompt', { cancelable: true });
    offer.prompt = async () => { window.__velnoxPrompted = true; };
    offer.userChoice = Promise.resolve({ outcome: 'dismissed' });
    window.dispatchEvent(offer);
    await new Promise((r) => setTimeout(r, 300));
    document.querySelector('button[aria-haspopup="menu"]').click();
    await new Promise((r) => setTimeout(r, 300));
    const button = [...document.querySelectorAll('[role="menu"] button')].find((b) => b.textContent.trim() === ${JSON.stringify(installLabel)});
    if (!button) return 'absent';
    button.click();
    await new Promise((r) => setTimeout(r, 300));
    return window.__velnoxPrompted ? 'prompted' : 'clicked, no prompt';
  })()`);

  // No network: the worker's own page, with nothing from before on it. The
  // worker is a target of its own, and fetches for the page: it is cut off too.
  const { targetInfos } = await send('Target.getTargets');
  const worker = targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(site));
  const { sessionId: w } = await send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
  const network = (offline) => ({ offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  for (const session of [s, w]) {
    await send('Network.enable', {}, session);
    await send('Network.emulateNetworkConditions', network(true), session);
  }
  await navigate('/clusters');
  result.offlineTitle = await evaluate('document.title');
  result.offlineText = await evaluate('document.body ? document.body.innerText : ""');
  for (const session of [s, w]) await send('Network.emulateNetworkConditions', network(false), session);
  await navigate('/');

  // Signing out through the menu, as a user does.
  result.cachedBeforeSignOut = await evaluate(cacheEntries);
  await evaluate(`(async () => {
    if (!document.querySelector('[role="menu"]')) document.querySelector('button[aria-haspopup="menu"]').click();
    await new Promise((r) => setTimeout(r, 300));
    [...document.querySelectorAll('[role="menu"] button')].find((b) => b.textContent.trim() === ${JSON.stringify(signOutLabel)}).click();
  })()`);
  result.signedOut = await until(`location.pathname.startsWith('/login')`);
  result.cachedAfterSignOut = await evaluate(cacheEntries);
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
}
process.stdout.write(JSON.stringify(result));
socket.close();
process.exit(0);

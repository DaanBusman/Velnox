import { apiGet, apiPost, apiPut, type ApiFailure } from '@/lib/client-api';

/**
 * This browser's notification subscription (ADR-062). The browser holds it;
 * the server is told, and either can be out of step with the other, so
 * "on" means both agree.
 */

export type PushState =
  | 'loading'
  /** No Web Push here: an older browser, or iOS outside an installed app. */
  | 'unsupported'
  /** No service worker: the certificate is not trusted. */
  | 'untrusted'
  /** The person or a policy blocked notifications for this site. */
  | 'denied'
  | 'off'
  | 'on';

export type PushResult = { ok: true } | { ok: false; denied?: boolean; error?: ApiFailure };

const supported = () =>
  typeof window !== 'undefined' &&
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window;

async function registration(): Promise<ServiceWorkerRegistration | null> {
  // `ready` never settles without a worker, which is the untrusted case.
  return (await navigator.serviceWorker.getRegistration('/')) ?? null;
}

export async function readPushState(): Promise<PushState> {
  if (!window.isSecureContext) return 'untrusted';
  if (!supported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const worker = await registration();
  if (!worker) return 'untrusted';
  const subscription = await worker.pushManager.getSubscription();
  if (!subscription) return 'off';
  const known = await apiPost<{ registered: boolean }>('/me/push/status', {
    endpoint: subscription.endpoint,
  });
  return known.ok && known.data.registered ? 'on' : 'off';
}

export async function enablePush(locale: string): Promise<PushResult> {
  // Asked first, while the click still counts as the person's own gesture.
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, denied: permission === 'denied' };

  const worker = await navigator.serviceWorker.ready;
  const key = await apiGet<{ publicKey: string }>('/me/push/key');
  if (!key.ok) return { ok: false, error: key.error };

  const applicationServerKey = Uint8Array.from(
    atob(key.data.publicKey.replace(/-/g, '+').replace(/_/g, '/')),
    (c) => c.charCodeAt(0),
  );
  let subscription = await worker.pushManager.getSubscription();
  if (subscription && !sameKey(subscription.options.applicationServerKey, applicationServerKey)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });

  const json = subscription.toJSON();
  const saved = await apiPut('/me/push/device', {
    endpoint: subscription.endpoint,
    keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
    locale: locale === 'nl' ? 'nl' : 'en',
  });
  if (!saved.ok) {
    await subscription.unsubscribe().catch(() => false);
    return { ok: false, error: saved.error };
  }
  return { ok: true };
}

function sameKey(current: ArrayBuffer | null, wanted: Uint8Array): boolean {
  if (!current) return false;
  const bytes = new Uint8Array(current);
  return bytes.length === wanted.length && bytes.every((byte, i) => byte === wanted[i]);
}

/** Server first: a browser that stopped listening but is still on the list is the worse half. */
export async function disablePush(): Promise<PushResult> {
  const worker = await registration();
  const subscription = await worker?.pushManager.getSubscription();
  if (!subscription) return { ok: true };
  const removed = await apiPost('/me/push/device/remove', { endpoint: subscription.endpoint });
  await subscription.unsubscribe().catch(() => false);
  return removed.ok ? { ok: true } : { ok: false, error: removed.error };
}

export async function testPush(): Promise<PushResult> {
  const worker = await registration();
  const subscription = await worker?.pushManager.getSubscription();
  if (!subscription) return { ok: false };
  const sent = await apiPost('/me/push/test', { endpoint: subscription.endpoint });
  return sent.ok ? { ok: true } : { ok: false, error: sent.error };
}

/** On signing out, while the session can still say which device this is. */
export async function forgetPushOnSignOut(): Promise<void> {
  if (!supported()) return;
  await disablePush().catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Back to the job after signing in
// ---------------------------------------------------------------------------

const AFTER_SIGN_IN = 'velnox:after-sign-in';
const JOB_PATH = /^\/jobs\/[0-9a-f-]{36}(\?decide=(approve|reject))?$/;

/** Only the shape a notification opens, so this can never become an open redirect. */
export const isJobReturnPath = (path: string): boolean => JOB_PATH.test(path);

export function rememberJobForSignIn(): void {
  const path = `${window.location.pathname}${window.location.search}`;
  if (!isJobReturnPath(path)) return;
  try {
    sessionStorage.setItem(AFTER_SIGN_IN, path);
  } catch {
    // Without storage the person lands on the dashboard, which also lists it.
  }
}

/** Where to go once signed in. Read once. */
export function afterSignIn(): string {
  try {
    const path = sessionStorage.getItem(AFTER_SIGN_IN);
    sessionStorage.removeItem(AFTER_SIGN_IN);
    if (path && isJobReturnPath(path)) return path;
  } catch {
    // As above.
  }
  return '/';
}

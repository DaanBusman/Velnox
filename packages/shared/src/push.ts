/**
 * Web Push: what the API and the worker must agree on (ADR-062).
 *
 * A browser hands Velnox an address to post to, and the worker posts to it. An
 * address taken from a request and fetched by a server is how an SSRF starts,
 * so only the push services of the browsers Velnox supports are accepted, when
 * the address is stored and again when it is used.
 */

const EXACT_HOSTS: ReadonlySet<string> = new Set(['fcm.googleapis.com', 'web.push.apple.com']);
const HOST_SUFFIXES: readonly string[] = ['.push.services.mozilla.com', '.notify.windows.com'];

export const PUSH_ENDPOINT_MAX_LENGTH = 2048;
/** Per account. Past it, the device added longest ago is forgotten. */
export const PUSH_MAX_DEVICES = 10;

export function isPushEndpoint(value: string): boolean {
  if (value.length > PUSH_ENDPOINT_MAX_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return EXACT_HOSTS.has(host) || HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** A browser's public key: an uncompressed P-256 point, base64url. */
export function isPushPublicKey(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{87}$/.test(value)) return false;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === 65 && bytes[0] === 0x04;
}

/** A browser's authentication secret: sixteen bytes, base64url. */
export function isPushAuthSecret(value: string): boolean {
  return /^[A-Za-z0-9_-]{22}$/.test(value) && Buffer.from(value, 'base64url').length === 16;
}

/**
 * What a notification carries. No customer, cluster, node or change: it passes
 * through the browser vendor's service and may be shown on a locked screen.
 * The service worker writes the sentence, and the page behind the sign-in says
 * what it is about.
 */
export type PushMessage =
  | { v: 1; kind: 'approval'; jobId: string; lang: string }
  | { v: 1; kind: 'test'; lang: string };

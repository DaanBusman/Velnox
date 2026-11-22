import {
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  createSign,
  randomBytes,
} from 'node:crypto';

/**
 * Web Push on the wire: message encryption (RFC 8291) and the server's
 * identification (VAPID, RFC 8292), with Node's own crypto.
 *
 * Written here rather than added as a dependency because it is this short, and
 * RFC 8291's own example is its test. The browser vendor's service carries the
 * message and cannot read it.
 */

const RECORD_SIZE = 4096;
const VAPID_LIFETIME_SECONDS = 12 * 60 * 60;
const SEND_TIMEOUT_MS = 10_000;

const b64 = (value: Buffer) => value.toString('base64url');

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = createHmac('sha256', salt).update(ikm).digest();
  return createHmac('sha256', prk)
    .update(Buffer.concat([info, Buffer.from([1])]))
    .digest()
    .subarray(0, length);
}

export interface PushKeys {
  /** The browser's public key, base64url. */
  p256dh: string;
  /** The browser's authentication secret, base64url. */
  auth: string;
}

/** Fixed values are for RFC 8291's example; a real message gets fresh ones. */
export function encryptMessage(
  plaintext: Buffer,
  keys: PushKeys,
  fixed?: { serverPrivateKey: Buffer; salt: Buffer },
): Buffer {
  const browserPublic = Buffer.from(keys.p256dh, 'base64url');
  const authSecret = Buffer.from(keys.auth, 'base64url');
  const salt = fixed?.salt ?? randomBytes(16);

  const ecdh = createECDH('prime256v1');
  if (fixed) ecdh.setPrivateKey(fixed.serverPrivateKey);
  else ecdh.generateKeys();
  const serverPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(browserPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), browserPublic, serverPublic]);
  const ikm = hkdf(authSecret, shared, keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02: this is the last, and only, record.
  const body = Buffer.concat([cipher.update(plaintext), cipher.update(Buffer.from([2])), cipher.final()]);

  const size = Buffer.alloc(4);
  size.writeUInt32BE(RECORD_SIZE);
  return Buffer.concat([
    salt,
    size,
    Buffer.from([serverPublic.length]),
    serverPublic,
    body,
    cipher.getAuthTag(),
  ]);
}

export interface VapidIdentity {
  /** PKCS#8 PEM. */
  privateKey: string;
  /** The uncompressed point the browser subscribed with, base64url. */
  publicKey: string;
  /** How the push service can reach whoever runs this server: https: or mailto:. */
  subject: string;
}

export function vapidHeader(endpoint: string, identity: VapidIdentity, nowMs = Date.now()): string {
  const encode = (value: unknown) => b64(Buffer.from(JSON.stringify(value)));
  const unsigned = `${encode({ typ: 'JWT', alg: 'ES256' })}.${encode({
    aud: new URL(endpoint).origin,
    exp: Math.floor(nowMs / 1000) + VAPID_LIFETIME_SECONDS,
    sub: identity.subject,
  })}`;
  const signature = createSign('SHA256')
    .update(unsigned)
    .sign({ key: createPrivateKey(identity.privateKey), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64(signature)}, k=${identity.publicKey}`;
}

export type DeliveryOutcome =
  /** The push service took it. Whether the device is on is not something it says. */
  | 'delivered'
  /** This browser's subscription no longer exists: forget it. */
  | 'gone'
  | 'failed';

export interface OutgoingPush {
  endpoint: string;
  keys: PushKeys;
  payload: unknown;
  ttlSeconds: number;
  /** A newer message with the same topic replaces one still undelivered. */
  topic?: string;
}

export async function deliver(
  push: OutgoingPush,
  identity: VapidIdentity,
  fetcher: typeof fetch = fetch,
): Promise<{ outcome: DeliveryOutcome; status: number | null }> {
  const body = encryptMessage(Buffer.from(JSON.stringify(push.payload)), push.keys);
  let response: Response;
  try {
    response = await fetcher(push.endpoint, {
      method: 'POST',
      // A push service has no reason to send a server somewhere else.
      redirect: 'error',
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      headers: {
        Authorization: vapidHeader(push.endpoint, identity),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(push.ttlSeconds),
        Urgency: 'high',
        ...(push.topic ? { Topic: push.topic } : {}),
      },
      body: new Uint8Array(body),
    });
    await response.body?.cancel().catch(() => undefined);
  } catch {
    return { outcome: 'failed', status: null };
  }
  if (response.ok) return { outcome: 'delivered', status: response.status };
  if (response.status === 404 || response.status === 410) {
    return { outcome: 'gone', status: response.status };
  }
  return { outcome: 'failed', status: response.status };
}

import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { deliver, encryptMessage, vapidHeader, type VapidIdentity } from './web-push';

/** RFC 8291, Appendix A. */
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  serverPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  browserPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  message:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

function identity(): VapidIdentity {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: Buffer.concat([
      Buffer.from([4]),
      Buffer.from(jwk.x!, 'base64url'),
      Buffer.from(jwk.y!, 'base64url'),
    ]).toString('base64url'),
    subject: 'https://example.test/velnox',
  };
}

const push = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
  keys: { p256dh: RFC.browserPublic, auth: RFC.auth },
  payload: { v: 1, kind: 'test', lang: 'en' },
  ttlSeconds: 60,
};

describe('message encryption', () => {
  it("produces RFC 8291's example byte for byte", () => {
    const message = encryptMessage(
      Buffer.from(RFC.plaintext),
      { p256dh: RFC.browserPublic, auth: RFC.auth },
      {
        serverPrivateKey: Buffer.from(RFC.serverPrivate, 'base64url'),
        salt: Buffer.from(RFC.salt, 'base64url'),
      },
    );
    expect(message.toString('base64url')).toBe(RFC.message);
  });

  it('never reuses a key or salt', () => {
    const keys = { p256dh: RFC.browserPublic, auth: RFC.auth };
    const a = encryptMessage(Buffer.from('same'), keys);
    const b = encryptMessage(Buffer.from('same'), keys);
    expect(a.subarray(0, 16).equals(b.subarray(0, 16))).toBe(false);
    expect(a.subarray(21, 86).equals(b.subarray(21, 86))).toBe(false);
  });
});

describe('VAPID', () => {
  it('signs a token for the push service, and only for it', () => {
    const me = identity();
    const now = Date.UTC(2026, 10, 22);
    const header = vapidHeader(`${push.endpoint}?x=1`, me, now);
    const [, token, key] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
    expect(key).toBe(me.publicKey);

    const [head, claims, signature] = token!.split('.');
    expect(JSON.parse(Buffer.from(head!, 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: now / 1000 + 12 * 3600,
      sub: me.subject,
    });

    const raw = Buffer.from(key!, 'base64url');
    const publicKey = createPublicKey({
      format: 'jwk',
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: raw.subarray(1, 33).toString('base64url'),
        y: raw.subarray(33).toString('base64url'),
      },
    });
    expect(
      verify(
        'sha256',
        Buffer.from(`${head}.${claims}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature!, 'base64url'),
      ),
    ).toBe(true);
  });
});

describe('delivery', () => {
  const answering = (status: number) =>
    vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch;

  it('sends encrypted, follows no redirect, and says what happened', async () => {
    const fetcher = answering(201);
    expect(await deliver({ ...push, topic: 'abc' }, identity(), fetcher)).toEqual({
      outcome: 'delivered',
      status: 201,
    });
    const [url, init] = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe(push.endpoint);
    expect(init.redirect).toBe('error');
    expect(init.headers).toMatchObject({ 'Content-Encoding': 'aes128gcm', TTL: '60', Topic: 'abc' });
    expect(Buffer.from(init.body).includes(Buffer.from('test'))).toBe(false);
  });

  it.each([404, 410])('forgets a subscription answered with %i', async (status) => {
    expect((await deliver(push, identity(), answering(status))).outcome).toBe('gone');
  });

  it.each([400, 401, 403, 429, 500])('keeps it, and reports failure, on %i', async (status) => {
    expect((await deliver(push, identity(), answering(status))).outcome).toBe('failed');
  });

  it('reports a network failure without throwing', async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await deliver(push, identity(), fetcher)).toEqual({ outcome: 'failed', status: null });
  });
});

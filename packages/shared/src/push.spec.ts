import { describe, expect, it } from 'vitest';
import { isPushAuthSecret, isPushEndpoint, isPushPublicKey } from './push';

describe('a push address', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
    'https://web.push.apple.com/QAbc',
  ])('accepts %s', (url) => expect(isPushEndpoint(url)).toBe(true));

  it.each([
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com:8443/fcm/send/abc',
    'https://user:pw@fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com.evil.example/x',
    'https://evilnotify.windows.com/x',
    'https://notify.windows.com.evil.example/x',
    'https://push.services.mozilla.com/x',
    'https://localhost/x',
    'https://127.0.0.1/x',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/x',
    'file:///etc/passwd',
    'not a url',
    `https://fcm.googleapis.com/${'a'.repeat(2048)}`,
  ])('refuses %s', (url) => expect(isPushEndpoint(url)).toBe(false));
});

describe('a browser key', () => {
  const point = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url');

  it('is an uncompressed P-256 point', () => {
    expect(isPushPublicKey(point)).toBe(true);
    expect(isPushPublicKey(Buffer.alloc(65, 7).toString('base64url'))).toBe(false);
    expect(isPushPublicKey(Buffer.alloc(33, 4).toString('base64url'))).toBe(false);
  });

  it('comes with a sixteen-byte secret', () => {
    expect(isPushAuthSecret(Buffer.alloc(16, 1).toString('base64url'))).toBe(true);
    expect(isPushAuthSecret(Buffer.alloc(15, 1).toString('base64url'))).toBe(false);
    expect(isPushAuthSecret('!'.repeat(22))).toBe(false);
  });
});

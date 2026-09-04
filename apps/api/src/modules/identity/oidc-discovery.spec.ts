import { describe, expect, it } from 'vitest';
import { fetchDiscoveryDocument, resolvesToPublicAddress } from './oidc-discovery';

/**
 * The discovery fetch is a request the server makes to an address an
 * administrator typed. Everything below is about that being the only thing it
 * can be talked into doing.
 */

describe('address checking', () => {
  const privateAddresses = [
    '127.0.0.1', //        loopback
    '10.1.2.3', //         RFC 1918
    '172.16.0.1', //       RFC 1918, bottom of the range
    '172.31.255.254', //   RFC 1918, top of the range
    '192.168.1.1', //      RFC 1918
    '169.254.169.254', //  cloud metadata, the one that matters most
    '100.64.0.1', //       carrier-grade NAT
    '0.0.0.0',
    '224.0.0.1', //        multicast
    '::1', //              IPv6 loopback
    'fe80::1', //          IPv6 link-local
    'fd00::1', //          IPv6 unique local
    '::ffff:127.0.0.1', // IPv4 loopback wearing an IPv6 hat
    '::ffff:169.254.169.254',
  ];

  for (const address of privateAddresses) {
    it(`refuses ${address}`, async () => {
      expect(await resolvesToPublicAddress(address)).toBe(false);
    });
  }

  const publicAddresses = ['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.0.1', '2606:4700::1111'];

  for (const address of publicAddresses) {
    it(`allows ${address}`, async () => {
      expect(await resolvesToPublicAddress(address)).toBe(true);
    });
  }

  it('refuses a hostname that does not resolve', async () => {
    expect(await resolvesToPublicAddress('velnox-nothing-resolves-here.invalid')).toBe(false);
  });

  it('refuses localhost, however it is spelled', async () => {
    // The whole point: a name is not safer than the address behind it.
    expect(await resolvesToPublicAddress('localhost')).toBe(false);
  });
});

describe('fetching a discovery document', () => {
  it('refuses plain HTTP', async () => {
    const result = await fetchDiscoveryDocument(
      'http://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration',
    );
    expect(result).toEqual({ ok: false, reason: 'not_https' });
  });

  it('refuses a URL that is not a URL', async () => {
    expect(await fetchDiscoveryDocument('not a url')).toEqual({ ok: false, reason: 'not_https' });
  });

  it('refuses an internal address before making any request', async () => {
    // https, so the scheme check passes; it must be stopped by the address.
    const result = await fetchDiscoveryDocument('https://169.254.169.254/latest/meta-data/');
    expect(result).toEqual({ ok: false, reason: 'address_not_public' });
  });

  it('refuses a private hostname', async () => {
    const result = await fetchDiscoveryDocument('https://localhost/.well-known/openid-configuration');
    expect(result).toEqual({ ok: false, reason: 'address_not_public' });
  });

  it('refuses a non-standard scheme', async () => {
    expect(await fetchDiscoveryDocument('file:///etc/passwd')).toEqual({
      ok: false,
      reason: 'not_https',
    });
  });
});

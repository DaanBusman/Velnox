import { describe, expect, it } from 'vitest';
import { buildBlockList, refusalFor } from './address-guard';

describe('which addresses a URL fetch may reach', () => {
  // As if the worker sat on two Docker networks, the way compose attaches it.
  const blocked = buildBlockList({ ownNetworks: ['172.19.0.4/16', '172.20.0.3/16'] });
  const refused = (address: string) => refusalFor(address, blocked) !== null;

  it.each([
    ['loopback', '127.0.0.1'],
    ['loopback, anywhere in the /8', '127.4.5.6'],
    ['the cloud metadata service', '169.254.169.254'],
    ['unspecified', '0.0.0.0'],
    ['multicast', '239.1.1.1'],
    ['broadcast', '255.255.255.255'],
    ['IPv6 loopback', '::1'],
    ['IPv6 unspecified', '::'],
    ['IPv6 link-local', 'fe80::1'],
    ['IPv4 loopback dressed as IPv6', '::ffff:127.0.0.1'],
    ['the metadata service dressed as IPv6', '::ffff:169.254.169.254'],
    ["Velnox's own data network, where PostgreSQL and Redis are", '172.19.0.2'],
    ["Velnox's own egress network", '172.20.255.1'],
  ])('refuses %s', (_what, address) => {
    expect(refused(address)).toBe(true);
  });

  it.each([
    ['a public mirror', '151.101.2.132'],
    ["an MSP's internal file server", '10.20.30.40'],
    ['a file server in another private range', '192.168.1.10'],
    ['a private range next to, but not inside, a Velnox network', '172.21.0.5'],
    ['public IPv6', '2a04:4e42::644'],
  ])('allows %s', (_what, address) => {
    expect(refused(address)).toBe(false);
  });

  it('refuses something that is not an address at all', () => {
    expect(refusalFor('example.com', blocked)).toBe('not an IP address');
  });
});

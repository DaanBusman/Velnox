import { BlockList, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

/**
 * Which addresses a library URL fetch may connect to.
 *
 * The worker is the one process with a route into customers' management
 * networks, and a URL is chosen by whoever adds it. So a fetch is a request
 * the worker makes on somebody's behalf to an address they picked, which is
 * the whole shape of server-side request forgery. The rule:
 *
 * **Refused:** loopback, unspecified, link-local (which is where cloud
 * metadata services live), multicast and broadcast — and every network the
 * worker itself is attached to, which is how Velnox's own PostgreSQL and Redis
 * are reached.
 *
 * **Allowed:** everything else, including private ranges. An MSP's ISOs very
 * often sit on an internal file server, and refusing RFC 1918 outright would
 * make the feature useless on exactly the networks it is for. The permission
 * that allows a fetch at all, `library.manage`, is held by MSP staff only.
 *
 * The decision is made on the address the connection will actually use — the
 * resolver's answer is checked, then that exact address is dialled — so a name
 * that resolves to something harmless for the check and to something else a
 * moment later cannot slip through.
 */

const ALWAYS_REFUSED: [string, number, 'ipv4' | 'ipv6'][] = [
  ['0.0.0.0', 8, 'ipv4'], // "this network", and 0.0.0.0 itself
  ['127.0.0.0', 8, 'ipv4'], // loopback
  ['169.254.0.0', 16, 'ipv4'], // link-local, including 169.254.169.254
  ['224.0.0.0', 4, 'ipv4'], // multicast
  ['240.0.0.0', 4, 'ipv4'], // reserved, and 255.255.255.255
  ['100.64.0.0', 10, 'ipv4'], // carrier-grade NAT; also Tailscale's metadata range
  ['::', 128, 'ipv6'], // unspecified
  ['::1', 128, 'ipv6'], // loopback
  ['fe80::', 10, 'ipv6'], // link-local
  ['ff00::', 8, 'ipv6'], // multicast
  ['fd00:ec2::', 32, 'ipv6'], // AWS's IPv6 metadata service
];

export interface AddressRule {
  /** Networks the worker is on, as `address/prefix`. Refused as well. */
  ownNetworks: string[];
}

/** The worker's own networks, read from its interfaces. */
export function ownNetworks(): string[] {
  const networks: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.cidr) networks.push(entry.cidr);
    }
  }
  return networks;
}

/** IPv4 in IPv6 clothing: `::ffff:127.0.0.1` is loopback, and is judged as such. */
const unmap = (address: string): string => {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return mapped ? mapped[1]! : address;
};

export function buildBlockList(rule: AddressRule): BlockList {
  const list = new BlockList();
  for (const [network, prefix, family] of ALWAYS_REFUSED) list.addSubnet(network, prefix, family);
  for (const cidr of rule.ownNetworks) {
    const [network, prefix] = cidr.split('/');
    if (!network || prefix === undefined) continue;
    const family = isIP(network) === 6 ? 'ipv6' : 'ipv4';
    list.addSubnet(network, Number(prefix), family);
  }
  return list;
}

/** Why an address was refused, or null when it may be dialled. */
export function refusalFor(address: string, blocked: BlockList): string | null {
  const plain = unmap(address);
  const family = isIP(plain);
  if (family === 0) return 'not an IP address';
  return blocked.check(plain, family === 6 ? 'ipv6' : 'ipv4')
    ? 'a loopback, link-local, multicast or Velnox-internal address'
    : null;
}

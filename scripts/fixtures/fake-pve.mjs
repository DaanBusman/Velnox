#!/usr/bin/env node
/**
 * A Proxmox VE API, faithful enough to prove Velnox against.
 *
 * Phase 4's acceptance criteria say "a real (or fixture-backed) cluster can be
 * added". This is the fixture: a small HTTPS server answering the endpoints
 * Velnox actually calls, with the response shapes a PVE 8 cluster returns.
 *
 * It exists because the alternative is proving discovery against a mock of the
 * code that calls it, which proves only that the mock was written to agree. Here
 * the TLS handshake is real, the certificate is real, the pinning is real, the
 * 401 for a wrong token is real, and the JSON goes over a socket.
 *
 * What it deliberately gets *wrong* is as important as what it gets right:
 *
 *   - `pve3` is offline, so the discovery path for an unreachable node is
 *     exercised rather than described.
 *   - `pve2` refuses `/apt/repositories` with a 403, so a per-node failure has
 *     to become a recorded problem instead of a failed run.
 *   - Ceph has `noout` set and one daemon on an older release, so the two
 *     conditions phase 9A must refuse to upgrade over are visible in phase 4.
 *
 * Not a test double for the Proxmox API in general. It answers what Velnox asks
 * and 501s the rest, loudly, so a new call site cannot pass by accident.
 *
 *   node scripts/fixtures/fake-pve.mjs --cert cert.pem --key key.pem [--port 8006]
 */

import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

const PORT = Number(option('port', '8006'));
const CERT = option('cert', null);
const KEY = option('key', null);

if (!CERT || !KEY) {
  console.error('Usage: fake-pve.mjs --cert cert.pem --key key.pem [--port 8006]');
  process.exit(2);
}

/** The one credential this fixture accepts. Not a secret — it guards nothing. */
const TOKEN_ID = 'root@pam!velnox';
const TOKEN_SECRET = 'fixture-secret-0000-0000-000000000000';

// ---------------------------------------------------------------------------
// The cluster this pretends to be
// ---------------------------------------------------------------------------

const NODES = {
  pve1: { online: true, nodeid: 1, ip: '10.90.0.11' },
  pve2: { online: true, nodeid: 2, ip: '10.90.0.12' },
  // Deliberately down. Velnox must inventory the other two and record why it
  // knows nothing about this one.
  pve3: { online: false, nodeid: 3, ip: '10.90.0.13' },
};

const nodeStatus = (node) => ({
  uptime: node === 'pve1' ? 1_209_600 : 864_000,
  pveversion: 'pve-manager/8.2.4/faa83925c9641325',
  cpuinfo: { cpus: 32, sockets: 1, model: 'AMD EPYC 7313P 16-Core Processor' },
  memory: { total: 137_438_953_472, used: 68_719_476_736, free: 68_719_476_736 },
  rootfs: { total: 107_374_182_400, used: 21_474_836_480, avail: 85_899_345_920 },
  'current-kernel': { sysname: 'Linux', release: '6.8.12-1-pve', machine: 'x86_64' },
});

const ROUTES = {
  '/api2/json/version': () => ({ version: '8.2.4', release: '8.2', repoid: 'faa83925c9641325' }),

  '/api2/json/cluster/status': () => [
    { type: 'cluster', id: 'cluster', name: 'fixture', nodes: 3, quorate: 1, version: 7 },
    ...Object.entries(NODES).map(([name, node]) => ({
      type: 'node',
      id: `node/${name}`,
      name,
      nodeid: node.nodeid,
      ip: node.ip,
      online: node.online ? 1 : 0,
      local: name === 'pve1' ? 1 : 0,
      level: '',
    })),
  ],

  '/api2/json/nodes': () =>
    Object.entries(NODES).map(([name, node]) => ({
      node: name,
      status: node.online ? 'online' : 'offline',
      cpu: node.online ? 0.08 : 0,
      maxcpu: 32,
      mem: node.online ? 68_719_476_736 : 0,
      maxmem: 137_438_953_472,
      disk: node.online ? 21_474_836_480 : 0,
      maxdisk: 107_374_182_400,
      uptime: node.online ? 864_000 : 0,
      level: '',
    })),

  '/api2/json/cluster/resources': () => [
    ...Object.keys(NODES).map((name) => ({ id: `node/${name}`, type: 'node', node: name })),
    {
      id: 'qemu/100',
      type: 'qemu',
      node: 'pve1',
      vmid: 100,
      name: 'db-primary',
      status: 'running',
      cpu: 0.14,
      maxcpu: 8,
      mem: 8_589_934_592,
      maxmem: 17_179_869_184,
      disk: 0,
      maxdisk: 107_374_182_400,
      uptime: 604_800,
      tags: 'production;database',
    },
    {
      id: 'qemu/101',
      type: 'qemu',
      node: 'pve2',
      vmid: 101,
      name: 'web-01',
      status: 'stopped',
      maxcpu: 4,
      maxmem: 8_589_934_592,
      maxdisk: 53_687_091_200,
    },
    {
      id: 'lxc/200',
      type: 'lxc',
      node: 'pve1',
      vmid: 200,
      name: 'monitoring',
      status: 'running',
      cpu: 0.01,
      maxcpu: 2,
      mem: 1_073_741_824,
      maxmem: 2_147_483_648,
      maxdisk: 21_474_836_480,
      uptime: 2_592_000,
    },
    {
      id: 'qemu/9000',
      type: 'qemu',
      node: 'pve1',
      vmid: 9000,
      name: 'debian-12-template',
      status: 'stopped',
      template: 1,
      maxcpu: 2,
      maxmem: 2_147_483_648,
    },
    { id: 'storage/pve1/local', type: 'storage', node: 'pve1', storage: 'local' },
  ],

  '/api2/json/cluster/ceph/status': () => ({
    fsid: '9f2b8a54-0a11-4f0c-9d8e-5b1a2c3d4e5f',
    health: {
      status: 'HEALTH_WARN',
      checks: {
        OSDMAP_FLAGS: { severity: 'HEALTH_WARN', summary: { message: 'noout flag(s) set' } },
      },
    },
    monmap: { mons: [{ name: 'pve1' }, { name: 'pve2' }, { name: 'pve3' }] },
    quorum_names: ['pve1', 'pve2'],
    osdmap: { osdmap: { num_osds: 6, num_up_osds: 4, num_in_osds: 6, flags: 'noout' } },
    pgmap: {
      num_pgs: 257,
      pgs_by_state: [
        { state_name: 'active+clean', count: 249 },
        { state_name: 'active+undersized+degraded', count: 8 },
      ],
      bytes_used: 3_298_534_883_328,
      bytes_total: 10_995_116_277_760,
    },
  }),

  '/api2/json/cluster/ceph/metadata': () => ({
    mon: {
      pve1: { name: 'pve1', hostname: 'pve1', ceph_version_short: '18.2.4' },
      pve2: { name: 'pve2', hostname: 'pve2', ceph_version_short: '18.2.4' },
    },
    mgr: { pve1: { name: 'pve1', hostname: 'pve1', ceph_version_short: '18.2.4' } },
    osd: {
      0: { id: 0, hostname: 'pve1', ceph_version_short: '18.2.4' },
      1: { id: 1, hostname: 'pve1', ceph_version_short: '18.2.4' },
      2: { id: 2, hostname: 'pve2', ceph_version_short: '18.2.4' },
      // One daemon behind. A cluster mid-upgrade, which phase 9A must refuse.
      3: { id: 3, hostname: 'pve2', ceph_version_short: '17.2.7' },
    },
  }),

  '/api2/json/cluster/ceph/flags': () => [
    { name: 'noout', value: 1, description: 'OSDs will not be marked out automatically' },
    { name: 'nobackfill', value: 0, description: 'Backfilling of PGs is suspended' },
    { name: 'norebalance', value: 0, description: 'Rebalancing of PGs is suspended' },
  ],
};

/** Per-node endpoints, keyed by the path after the node name. */
const NODE_ROUTES = {
  status: (node) => nodeStatus(node),

  subscription: (node) =>
    node === 'pve1'
      ? { status: 'active', level: 'c', productname: 'Proxmox VE Community Subscription' }
      : // A node that has never had one answers `data: null` with a 200. Treating
        // that as an error would mark every unsubscribed node as a failed run.
        null,

  'apt/repositories': (node) => {
    if (node === 'pve2') {
      // Deliberate: a per-node failure must become a recorded problem, not a
      // failed discovery run.
      const error = new Error('forbidden');
      error.status = 403;
      throw error;
    }

    return {
      digest: 'fixture',
      files: [
        {
          path: '/etc/apt/sources.list',
          'file-type': 'list',
          repositories: [
            {
              Enabled: 1,
              Types: ['deb'],
              URIs: ['http://ftp.debian.org/debian'],
              Suites: ['bookworm'],
              Components: ['main', 'contrib'],
            },
          ],
        },
        {
          path: '/etc/apt/sources.list.d/pve-enterprise.list',
          'file-type': 'list',
          repositories: [
            {
              Enabled: 0,
              Types: ['deb'],
              URIs: ['https://enterprise.proxmox.com/debian/pve'],
              Suites: ['bookworm'],
              Components: ['pve-enterprise'],
              Comment: 'no subscription',
            },
          ],
        },
      ],
    };
  },

  'apt/update': (node) =>
    node === 'pve1'
      ? [
          { Package: 'pve-manager', Version: '8.2.7', OldVersion: '8.2.4', Priority: 'optional' },
          { Package: 'openssl', Version: '3.0.14-1', OldVersion: '3.0.13-1', Priority: 'standard' },
        ]
      : [],

  storage: () => [
    {
      storage: 'local',
      type: 'dir',
      active: 1,
      enabled: 1,
      shared: 0,
      content: 'iso,vztmpl,backup',
      total: 107_374_182_400,
      used: 21_474_836_480,
      avail: 85_899_345_920,
    },
    {
      storage: 'ceph-vm',
      type: 'rbd',
      active: 1,
      enabled: 1,
      shared: 1,
      content: 'images,rootdir',
      total: 10_995_116_277_760,
      used: 3_298_534_883_328,
      avail: 7_696_581_394_432,
    },
    // Configured, not reachable. Every figure absent, which must render as a
    // dash rather than as an empty array.
    { storage: 'backup-nfs', type: 'nfs', active: 0, enabled: 1, shared: 1, content: 'backup' },
  ],

  network: (node) => [
    {
      iface: 'vmbr0',
      type: 'bridge',
      active: 1,
      autostart: 1,
      method: 'static',
      cidr: `${NODES[node].ip}/24`,
      gateway: '10.90.0.1',
      bridge_ports: 'bond0',
      bridge_vlan_aware: 1,
    },
    {
      iface: 'bond0',
      type: 'bond',
      active: 1,
      autostart: 1,
      method: 'manual',
      bond_mode: '802.3ad',
      slaves: 'enp1s0f0 enp1s0f1',
    },
    { iface: 'enp1s0f0', type: 'eth', active: 1, autostart: 0, method: 'manual' },
  ],
};

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

const send = (response, status, body) => {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json;charset=UTF-8',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
};

/** Exactly what Proxmox does with a wrong or missing token. */
const unauthorized = (response) => send(response, 401, { data: null });

const server = createServer(
  { cert: readFileSync(CERT), key: readFileSync(KEY) },
  (request, response) => {
    const path = (request.url ?? '').split('?')[0];

    const authorization = request.headers.authorization ?? '';
    const authorized = authorization === `PVEAPIToken=${TOKEN_ID}=${TOKEN_SECRET}`;

    /*
     * `/version` answers 401 when unauthenticated rather than refusing the
     * handshake. That is what makes the probe work: Velnox reads the certificate
     * from a connection that carries no credential, and a 401 is the strongest
     * available signal that something spoke Proxmox.
     */
    if (!authorized) {
      console.log(`401 ${path}`);
      return unauthorized(response);
    }

    if (ROUTES[path]) {
      console.log(`200 ${path}`);
      return send(response, 200, { data: ROUTES[path]() });
    }

    const nodeMatch = /^\/api2\/json\/nodes\/([^/]+)\/(.+)$/.exec(path);
    if (nodeMatch) {
      const [, node, rest] = nodeMatch;
      if (!NODES[node]) return send(response, 500, { data: null, message: `no such node '${node}'` });

      const handler = NODE_ROUTES[rest];
      if (handler) {
        try {
          const data = handler(node);
          console.log(`200 ${path}`);
          return send(response, 200, { data });
        } catch (error) {
          const status = error.status ?? 500;
          console.log(`${status} ${path}`);
          return send(response, status, { data: null, message: error.message });
        }
      }
    }

    // Loudly, so a new call site in Velnox cannot pass by accident.
    console.log(`501 ${path}`);
    send(response, 501, { data: null, message: `fake-pve does not implement ${path}` });
  },
);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`fake-pve listening on ${PORT}`);
  console.log(`token: ${TOKEN_ID} = ${TOKEN_SECRET}`);
});

/**
 * Virtual machines for the fixture Proxmox (Phase 5B), and a mail sink.
 *
 * Loaded by fake-pve.mjs only with `--vms`, beside the storage module, whose
 * files and tasks these VMs use. What it does, and what it does not:
 *
 * - **Create** checks what Proxmox checks that Velnox could get wrong: the VMID
 *   is free, every CD and import volume named exists on its storage, the disk
 *   storage takes images, and the bridge exists. It gives the first NIC a MAC,
 *   as Proxmox does.
 * - **Start** reads the answer ISO attached to the VM — Joliet, as the guest
 *   would — and keeps a copy of what was in it, so the harness can check what a
 *   guest was handed. Then it "installs": after `--install-seconds`, the guest
 *   agent answers and the done marker exists.
 * - A VM whose name starts with `fail-` stops a few seconds after starting,
 *   which is what a crashed install looks like from outside.
 * - A VM configured without the agent never answers, and so never finishes.
 *
 * It installs nothing. Whether Windows or Linux actually accepts the answer
 * file is proven elsewhere (the generators' tests, cloud-init's own schema
 * check), not here.
 *
 * The mail sink is SMTP without TLS on `--smtp-port`, and writes each message
 * to `<dir>/mail/` as it arrived.
 */

import { createServer } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const MARKERS = new Set([
  'C:\\Windows\\Temp\\velnox-provisioned.txt',
  '/var/lib/velnox/provisioned',
]);

/** Read the Joliet root of an ISO: the names a guest sees, and their bytes. */
function readJoliet(iso) {
  const SECTOR = 2048;
  for (let sector = 16; sector < 32; sector += 1) {
    const d = iso.subarray(sector * SECTOR, (sector + 1) * SECTOR);
    if (d[0] === 255) break;
    if (d[0] !== 2 || d.subarray(88, 91).toString('latin1') !== '%/E') continue;
    const rootExtent = d.readUInt32LE(156 + 2);
    const rootSize = d.readUInt32LE(156 + 10);
    const files = {};
    let offset = rootExtent * SECTOR;
    const end = offset + rootSize;
    while (offset < end) {
      const length = iso[offset];
      if (length === 0) {
        offset = (Math.floor(offset / SECTOR) + 1) * SECTOR;
        continue;
      }
      const nameLength = iso[offset + 32];
      const raw = iso.subarray(offset + 33, offset + 33 + nameLength);
      if (!(nameLength === 1 && raw[0] <= 1) && !(iso[offset + 25] & 2)) {
        let name = '';
        for (let i = 0; i < raw.length; i += 2) name += String.fromCharCode(raw.readUInt16BE(i));
        const extent = iso.readUInt32LE(offset + 2);
        const size = iso.readUInt32LE(offset + 10);
        files[name] = iso.subarray(extent * SECTOR, extent * SECTOR + size);
      }
      offset += length;
    }
    return files;
  }
  return null;
}

const readForm = (request) =>
  new Promise((resolve) => {
    const chunks = [];
    request.on('data', (c) => chunks.push(c));
    request.on('end', () =>
      resolve(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()))),
    );
  });

export function installVms({ dir, storage, nodes, installSeconds, log, existingVmids }) {
  const vms = new Map();
  const answersDir = join(dir, 'answers-seen');
  mkdirSync(answersDir, { recursive: true });
  let macCounter = 0x10;

  const volumeExists = (node, volid) => {
    const m = /^([^:]+):(iso|import)\/(.+)$/.exec(volid);
    if (!m) return false;
    const [, name, content, file] = m;
    try {
      return existsSync(join(storage.root(node, name), content, file));
    } catch {
      return false;
    }
  };

  const volumesIn = (value) => {
    const out = [];
    for (const m of String(value).matchAll(/(?:^|[=,])([A-Za-z0-9._-]+:(?:iso|import)\/[^,]+)/g))
      out.push(m[1]);
    return out;
  };

  const problemWith = (node, config) => {
    for (const [key, value] of Object.entries(config)) {
      if (!/^(ide\d|sata\d|scsi\d)$/.test(key)) continue;
      for (const volid of volumesIn(value)) {
        if (!volumeExists(node, volid)) return `volume '${volid}' does not exist`;
      }
      const disk = /^([A-Za-z0-9._-]+):\d+/.exec(String(value));
      if (disk && !String(value).includes('media=cdrom')) {
        const st = storage.storageList(node).find((s) => s.storage === disk[1]);
        if (!st || !st.content.split(',').includes('images'))
          return `storage '${disk[1]}' does not take images`;
      }
    }
    return null;
  };

  const task = (node, type, error) =>
    storage.newTask(
      node,
      type,
      error ? `command failed: ${error}` : 'OK',
      error ? [error] : ['TASK OK'],
    );

  const status = (vm) => {
    if (vm.status === 'running' && vm.failAt && Date.now() >= vm.failAt) vm.status = 'stopped';
    return vm.status;
  };
  const agentReady = (vm) =>
    status(vm) === 'running' &&
    /enabled=1|^1$/.test(String(vm.config.agent ?? '')) &&
    vm.readyAt !== null &&
    Date.now() >= vm.readyAt;

  function handle(request, response, node, rest, query, send) {
    const method = request.method ?? 'GET';
    const m = /^qemu(?:\/(\d+)(?:\/(.+))?)?$/.exec(rest);
    if (!m) return false;
    const vmid = m[1] ? Number(m[1]) : null;
    const action = m[2] ?? null;
    const vm = vmid !== null ? vms.get(vmid) : null;
    const reply = (status, data, message) =>
      send(response, status, { data, ...(message ? { message } : {}) });

    if (vmid === null && method === 'POST') {
      void readForm(request).then((form) => {
        const id = Number(form.vmid);
        if (vms.has(id) || existingVmids.includes(id))
          return reply(500, null, `VM ${id} already exists`);
        const config = { ...form };
        delete config.vmid;
        if (config.net0) {
          const bridge = /bridge=([^,]+)/.exec(config.net0)?.[1];
          if (bridge !== 'vmbr0') return reply(500, null, `bridge '${bridge}' does not exist`);
          macCounter += 1;
          const mac =
            `BC:24:11:00:${(macCounter >> 8).toString(16).padStart(2, '0')}:${(macCounter & 0xff).toString(16).padStart(2, '0')}`.toUpperCase();
          config.net0 = config.net0.replace(/^([a-z0-9]+)(,|$)/, `$1=${mac}$2`);
        }
        const problem = problemWith(node, config);
        if (problem) return reply(200, task(node, 'qmcreate', problem));
        vms.set(id, { node, config, status: 'stopped', readyAt: null, failAt: null, keys: 0 });
        log(`vm ${id} created on ${node}: ${config.name}`);
        reply(200, task(node, 'qmcreate'));
      });
      return true;
    }
    if (!vm || vm.node !== node) {
      reply(
        500,
        null,
        `Configuration file 'nodes/${node}/qemu-server/${vmid}.conf' does not exist`,
      );
      return true;
    }

    if (action === 'config' && method === 'GET') return (reply(200, vm.config), true);
    if (action === 'config' && method === 'POST') {
      void readForm(request).then((form) => {
        const next = { ...vm.config };
        for (const key of (form.delete ?? '').split(',').filter(Boolean)) delete next[key];
        for (const [key, value] of Object.entries(form)) if (key !== 'delete') next[key] = value;
        const problem = problemWith(node, next);
        if (problem) return reply(200, task(node, 'qmconfig', problem));
        vm.config = next;
        reply(200, task(node, 'qmconfig'));
      });
      return true;
    }
    if (action === 'resize' && method === 'PUT') return (reply(200, null), true);
    if (action === 'status/current') {
      return (
        reply(200, {
          vmid,
          status: status(vm),
          name: vm.config.name,
          agent: vm.config.agent ? 1 : 0,
        }),
        true
      );
    }
    if (action === 'status/start' && method === 'POST') {
      vm.status = 'running';
      vm.readyAt = Date.now() + installSeconds * 1000;
      vm.failAt = /^fail-/i.test(vm.config.name ?? '') ? Date.now() + 3000 : null;
      // What the guest was handed.
      for (const [key, value] of Object.entries(vm.config)) {
        if (!/^ide\d$/.test(key)) continue;
        for (const volid of volumesIn(value)) {
          if (!/velnox-answers-/.test(volid)) continue;
          const [, name, , file] = /^([^:]+):(iso)\/(.+)$/.exec(volid);
          const files = readJoliet(readFileSync(join(storage.root(node, name), 'iso', file)));
          const out = join(answersDir, String(vmid));
          mkdirSync(out, { recursive: true });
          for (const [fname, bytes] of Object.entries(files ?? {}))
            writeFileSync(join(out, fname), bytes);
          log(`vm ${vmid} answer media ${volid}: ${Object.keys(files ?? {}).join(', ')}`);
        }
      }
      log(`vm ${vmid} started`);
      return (reply(200, task(node, 'qmstart')), true);
    }
    if (action === 'status/stop' && method === 'POST') {
      vm.status = 'stopped';
      return (reply(200, task(node, 'qmstop')), true);
    }
    if (action === 'sendkey' && method === 'PUT') {
      vm.keys += 1;
      return (reply(200, null), true);
    }
    if (action === null && method === 'DELETE') {
      if (status(vm) === 'running')
        return (
          reply(200, task(node, 'qmdestroy', `VM ${vmid} is running - destroy failed`)),
          true
        );
      vms.delete(vmid);
      log(`vm ${vmid} destroyed (purge=${query.get('purge')})`);
      return (reply(200, task(node, 'qmdestroy')), true);
    }
    if (action === 'agent/ping' && method === 'POST') {
      return (
        agentReady(vm)
          ? reply(200, { result: {} })
          : reply(500, null, 'QEMU guest agent is not running'),
        true
      );
    }
    if (action === 'agent/file-read') {
      const file = query.get('file');
      if (!agentReady(vm)) return (reply(500, null, 'QEMU guest agent is not running'), true);
      if (!MARKERS.has(file))
        return (reply(500, null, `open ${file}: No such file or directory`), true);
      return (reply(200, { content: 'velnox\n', truncated: false }), true);
    }
    if (action === 'agent/network-get-interfaces') {
      if (!agentReady(vm)) return (reply(500, null, 'QEMU guest agent is not running'), true);
      const mac = /=([0-9A-F:]{17})/.exec(vm.config.net0 ?? '')?.[1]?.toLowerCase();
      return (
        reply(200, {
          result: [
            {
              name: 'lo',
              'ip-addresses': [{ 'ip-address': '127.0.0.1', 'ip-address-type': 'ipv4', prefix: 8 }],
            },
            {
              name: 'eth0',
              'hardware-address': mac,
              'ip-addresses': [
                {
                  'ip-address': `192.0.2.${100 + (vmid % 100)}`,
                  'ip-address-type': 'ipv4',
                  prefix: 24,
                },
                { 'ip-address': 'fe80::be24:11ff:fe00:1', 'ip-address-type': 'ipv6', prefix: 64 },
              ],
            },
          ],
        }),
        true
      );
    }
    reply(501, null, `fake-pve does not implement ${method} qemu/${vmid}/${action}`);
    return true;
  }

  return {
    handle,
    resources: () =>
      [...vms.entries()].map(([vmid, vm]) => ({
        id: `qemu/${vmid}`,
        type: 'qemu',
        node: vm.node,
        vmid,
        name: vm.config.name,
        status: status(vm),
      })),
    nextId: () => {
      let id = 100;
      while (vms.has(id) || existingVmids.includes(id)) id += 1;
      return id;
    },
    stats: () => ({
      vms: [...vms.keys()],
      keys: Object.fromEntries([...vms].map(([id, vm]) => [id, vm.keys])),
    }),
  };
}

/** A mail server that accepts anything and keeps it. Plain SMTP, for a lab. */
export function startSmtpSink({ port, dir, log }) {
  const out = join(dir, 'mail');
  mkdirSync(out, { recursive: true });
  let count = 0;
  const server = createServer((socket) => {
    let buffer = '';
    let inData = false;
    let data = '';
    const say = (line) => socket.write(`${line}\r\n`);
    say('220 fake-pve ESMTP ready');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          data += buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          count += 1;
          const file = join(out, `${String(count).padStart(3, '0')}.eml`);
          writeFileSync(file, data.replace(/\r\n\.\./g, '\r\n.'), 'latin1');
          log(`smtp: stored ${file}`);
          data = '';
          say('250 OK queued');
          continue;
        }
        const nl = buffer.indexOf('\r\n');
        if (nl === -1) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO') {
          say('250-fake-pve');
          say('250-8BITMIME');
          say('250 SIZE 52428800');
        } else if (verb === 'HELO') say('250 fake-pve');
        else if (verb === 'MAIL' || verb === 'RCPT' || verb === 'RSET' || verb === 'NOOP')
          say('250 OK');
        else if (verb === 'DATA') {
          inData = true;
          say('354 End data with <CR><LF>.<CR><LF>');
        } else if (verb === 'QUIT') {
          say('221 Bye');
          socket.end();
          return;
        } else say('502 Not implemented');
      }
    });
    socket.on('error', () => undefined);
  });
  server.listen(port, '0.0.0.0', () => log(`smtp listening on ${port}`));
  return server;
}

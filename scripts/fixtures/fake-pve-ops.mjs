/**
 * Operations for the fixture Proxmox (Phase 6 onward): a cluster that changes.
 *
 * Loaded by fake-pve.mjs with `--ops` (and `--storage-dir`, for its tasks).
 * Every node is online, and each keeps state the update path reads and changes:
 *
 * - **Pending updates**, per node: a security update, an ordinary one, a kernel
 *   and a Proxmox package — what `/apt/update` lists and `apt-get -s` prints.
 * - **Kernels**: the one running and the ones installed (`/apt/versions`). A
 *   dist-upgrade installs the new kernel and leaves `/var/run/reboot-required`;
 *   only a reboot makes it the running one.
 * - **Reboots**: `POST /status {command: reboot}` takes the node away for
 *   `--reboot-seconds`, and it comes back with a fresh uptime on its newest
 *   kernel. Quorum, `/cluster/status` and `/cluster/resources` follow.
 * - **SSH exec**, on the SFTP server's port: the commands Velnox's registry
 *   sends, recognised by their argv after the node guard, and nothing else —
 *   anything unrecognised is refused and logged as `EXEC REFUSED`. The guard's
 *   node name is how this one server knows which node it is playing.
 *
 * `--fail-upgrade NODE` makes that node's dist-upgrade fail as dpkg would.
 *
 * Phase 7 adds guests that move: VMs and a container on Ceph (shared), one VM
 * with its disk on a node's own `local` storage (which cannot move live), live
 * migration and container restart-migration, shutdown and start, and a reboot
 * that stops whatever is still running on the node. Ceph is HEALTH_OK here.
 *
 * `<storage-dir>/ops-control.json`, read on every request, lets a harness
 * break things on purpose: `{"offline": ["pve3"]}` takes nodes away;
 * `{"cephWarnAfterReboot": "pve2"}` makes Ceph HEALTH_WARN from that node's
 * next reboot on.
 *
 * Phase 7B: `{"pve": "9.0.6"}` makes every node report that version, and
 * Proxmox 9's HA rules (`/cluster/ha/rules`) answer; on 8 they answer 501 as
 * PVE 8 does. The rules live in the fixture, so they outlast Velnox.
 */

import { readFileSync } from 'node:fs';
import { installCeph } from './fake-pve-ceph.mjs';
import { join } from 'node:path';

const KERNEL_RUNNING = '6.8.12-4';
const KERNEL_NEW = '6.8.12-5';

const initialPending = () => [
  {
    Package: 'libssl3',
    OldVersion: '3.0.13-1~deb12u1',
    Version: '3.0.14-1~deb12u2',
    Origin: 'Debian',
    archive: 'Debian-Security:12/stable-security',
    ChangeLogUrl: 'https://security.debian.org/changelogs/libssl3',
  },
  { Package: 'vim-tiny', OldVersion: '2:9.0.1378-2', Version: '2:9.0.1378-2+deb12u1', Origin: 'Debian', archive: 'Debian:12.7/stable' },
  {
    Package: `proxmox-kernel-${KERNEL_NEW}-pve-signed`,
    OldVersion: null,
    Version: KERNEL_NEW,
    Origin: 'Proxmox',
    archive: 'Proxmox:bookworm/pve-no-subscription',
  },
  { Package: 'pve-manager', OldVersion: '8.2.4', Version: '8.2.7', Origin: 'Proxmox', archive: 'Proxmox:bookworm/pve-no-subscription' },
];

const GIB = 1024 ** 3;

export function installOps({ nodes, storage, log, dir, rebootSeconds = 8, failUpgrade = [] }) {
  const state = {};
  let cephWarn = false;
  const control = () => {
    try {
      return JSON.parse(readFileSync(join(dir, 'ops-control.json'), 'utf8'));
    } catch {
      return {};
    }
  };

  const ceph = installCeph({ nodes, log, control, storage, extraWarn: () => cephWarn });

  /** The version every node reports: PVE 8 unless the control file says otherwise. */
  const version = () => String(control().pve ?? '8.2.4');
  const major = () => Number(version().split('.')[0]);
  const haRules = new Map();

  /** Cluster-wide routes that change something: Proxmox 9's HA rules. */
  function handleCluster(request, response, path, send) {
    if (ceph.handleCluster(request, response, path, send, readForm)) return true;
    const match = /^\/api2\/json\/cluster\/ha\/rules(?:\/([^/]+))?$/.exec(path);
    if (!match) return false;
    const method = request.method ?? 'GET';
    if (major() < 9) {
      send(response, 501, { data: null, message: `Method '${method} /cluster/ha/rules' not implemented` });
      return true;
    }
    const id = match[1] ? decodeURIComponent(match[1]) : null;
    if (method === 'GET' && !id) {
      send(response, 200, { data: [...haRules.values()] });
      return true;
    }
    if (method === 'DELETE' && id) {
      if (!haRules.delete(id)) send(response, 500, { data: null, message: `HA rule '${id}' does not exist` });
      else {
        log(`ops: HA rule ${id} removed`);
        send(response, 200, { data: null });
      }
      return true;
    }
    readForm(request).then((form) => {
      const rule = id ?? form.rule;
      const fail = (message) => send(response, 400, { data: null, message, errors: { rule: message } });
      if (method === 'POST' && haRules.has(rule)) return fail(`HA rule '${rule}' already exists`);
      if (method === 'PUT' && !haRules.has(rule)) return fail(`HA rule '${rule}' does not exist`);
      if (!['node-affinity', 'resource-affinity'].includes(form.type)) return fail(`invalid type '${form.type}'`);
      const resources = String(form.resources ?? '').split(',').filter(Boolean);
      if (!resources.length || resources.some((r) => !/^(vm|ct):\d+$/.test(r))) return fail('invalid resources');
      if (form.type === 'resource-affinity' && !['positive', 'negative'].includes(form.affinity)) return fail('invalid affinity');
      if (form.type === 'node-affinity' && !form.nodes) return fail('nodes missing');
      const { rule: _ignored, ...rest } = form;
      haRules.set(rule, { rule, ...rest, disable: Number(form.disable ?? 0), ...(form.strict !== undefined ? { strict: Number(form.strict) } : {}) });
      log(`ops: HA rule ${rule} ${method === 'POST' ? 'created' : 'updated'}: ${form.type} ${form.affinity ?? form.nodes} ${resources.join(',')}`);
      send(response, 200, { data: null });
    });
    return true;
  }

  const guests = new Map(
    [
      { vmid: 100, kind: 'qemu', node: 'pve1', name: 'db-primary', mem: 24, config: { scsi0: 'ceph-vm:vm-100-disk-0,size=64G' } },
      { vmid: 200, kind: 'lxc', node: 'pve1', name: 'monitoring', mem: 2, config: { rootfs: 'ceph-vm:subvol-200-disk-0,size=8G' } },
      { vmid: 101, kind: 'qemu', node: 'pve2', name: 'web-01', mem: 4, config: { scsi0: 'ceph-vm:vm-101-disk-0,size=32G' } },
      { vmid: 102, kind: 'qemu', node: 'pve3', name: 'build-local', mem: 4, config: { scsi0: 'local:102/vm-102-disk-0.qcow2,size=32G' } },
      { vmid: 9000, kind: 'qemu', node: 'pve1', name: 'debian-12-template', mem: 2, template: true, stopped: true, config: { scsi0: 'ceph-vm:base-9000-disk-0' } },
    ].map((g) => [g.vmid, { ...g, status: g.stopped ? 'stopped' : 'running', maxmem: g.mem * GIB }]),
  );
  for (const [name, node] of Object.entries(nodes)) {
    node.online = true;
    state[name] = {
      pending: initialPending(),
      kernels: [KERNEL_RUNNING],
      running: KERNEL_RUNNING,
      rebootMarker: false,
      bootedAt: Date.now() - 864_000_000,
      backAt: 0,
      reboots: 0,
      upgrades: 0,
    };
  }

  /** A node coming back from a reboot when its time is up. */
  const tick = (name) => {
    const s = state[name];
    const forcedOffline = (control().offline ?? []).includes(name);
    if (!s.backAt) nodes[name].online = !forcedOffline;
    if (s.backAt && Date.now() >= s.backAt) {
      s.backAt = 0;
      s.bootedAt = Date.now();
      s.running = s.kernels.slice().sort(compare).pop();
      s.rebootMarker = false;
      nodes[name].online = true;
      log(`ops: ${name} is back on ${s.running}`);
    }
  };
  const tickAll = () => Object.keys(state).forEach(tick);

  const quorate = () => {
    tickAll();
    const all = Object.values(nodes);
    return all.filter((n) => n.online).length > all.length / 2;
  };

  const versionsOf = (name) => {
    const s = state[name];
    return [
      { Package: 'proxmox-ve', Version: '8.2.0', CurrentState: 'Installed', RunningKernel: `${s.running}-pve` },
      ...s.kernels.map((v) => ({ Package: `proxmox-kernel-${v}-pve-signed`, Version: v, CurrentState: 'Installed' })),
    ];
  };

  const offline = (send, response, name) =>
    send(response, 595, { data: null, message: `no route to host ${name}` });

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  function handle(request, response, node, rest, _query, send) {
    tick(node);
    const method = request.method ?? 'GET';
    const s = state[node];
    if (!s) return false;

    if (rest === 'status' && method === 'GET') {
      if (!nodes[node].online) return (offline(send, response, node), true);
      send(response, 200, {
        data: {
          uptime: Math.floor((Date.now() - s.bootedAt) / 1000),
          pveversion: `pve-manager/${version()}/faa83925c9641325`,
          cpuinfo: { cpus: 32, sockets: 1, model: 'AMD EPYC 7313P 16-Core Processor' },
          memory: { total: 128 * GIB, used: nodeMemory(node), free: 128 * GIB - nodeMemory(node) },
          rootfs: { total: 107_374_182_400, used: 21_474_836_480, avail: 85_899_345_920 },
          'current-kernel': { sysname: 'Linux', release: `${s.running}-pve`, machine: 'x86_64' },
        },
      });
      return true;
    }
    if (rest === 'status' && method === 'POST') {
      readForm(request).then((form) => {
        if (form.command !== 'reboot') return send(response, 400, { data: null, message: 'only reboot' });
        if (!nodes[node].online) return offline(send, response, node);
        s.reboots += 1;
        log(`ops: ${node} rebooting (reboot ${s.reboots})`);
        // Proxmox answers, then goes.
        send(response, 200, { data: null });
        setTimeout(() => {
          nodes[node].online = false;
          s.backAt = Date.now() + rebootSeconds * 1000;
          // Whatever still runs there stops with it.
          for (const g of guests.values()) {
            if (g.node === node && g.status === 'running') {
              g.status = 'stopped';
              log(`ops: ${g.kind} ${g.vmid} stopped by ${node}'s reboot`);
            }
          }
          if (control().cephWarnAfterReboot === node) {
            cephWarn = true;
            log('ops: Ceph is HEALTH_WARN from now on');
          }
        }, 500);
      });
      return true;
    }
    if (!nodes[node].online) return (offline(send, response, node), true);

    if (ceph.handleNode(request, response, node, rest, send, readForm)) return true;
    if (rest === 'apt/update' && method === 'GET') {
      send(response, 200, {
        data: [...s.pending, ...ceph.pendingFor(node)].map(({ archive: _archive, ...p }) => ({ ...p, Priority: 'optional', Section: 'admin' })),
      });
      return true;
    }
    if (rest === 'apt/update' && method === 'POST') {
      send(response, 200, { data: storage.newTask(node, 'aptupdate', 'OK', ['Reading package lists...', 'TASK OK']) });
      return true;
    }
    if (rest === 'apt/versions') {
      send(response, 200, { data: versionsOf(node) });
      return true;
    }

    // Guests: configuration, migration, shutdown and start.
    const guestMatch = /^(qemu|lxc)\/(\d+)\/(config|migrate|status\/(?:shutdown|start|current))$/.exec(rest);
    if (guestMatch) {
      const [, kind, id, action] = guestMatch;
      const g = guests.get(Number(id));
      if (!g || g.kind !== kind || g.node !== node) {
        send(response, 500, { data: null, message: `Configuration file 'nodes/${node}/${kind === 'qemu' ? 'qemu-server' : 'lxc'}/${id}.conf' does not exist` });
        return true;
      }
      if (action === 'config') return (send(response, 200, { data: { name: g.name, memory: g.mem * 1024, ...g.config } }), true);
      if (action === 'status/current') return (send(response, 200, { data: { vmid: g.vmid, status: g.status, name: g.name } }), true);
      readForm(request).then((form) => {
        const task = (type, error) =>
          send(response, 200, { data: storage.newTask(node, type, error ? `command failed: ${error}` : 'OK', error ? [error] : ['TASK OK']) });
        if (action === 'status/shutdown') {
          g.status = 'stopped';
          log(`ops: ${kind} ${g.vmid} shut down on ${node}`);
          return task(kind === 'qemu' ? 'qmshutdown' : 'vzshutdown');
        }
        if (action === 'status/start') {
          g.status = 'running';
          log(`ops: ${kind} ${g.vmid} started on ${node}`);
          return task(kind === 'qemu' ? 'qmstart' : 'vzstart');
        }
        const target = form.target;
        if (!nodes[target] || !nodes[target].online || target === node) return task('qmigrate', `target node '${target}' is not online`);
        const local = Object.values(g.config).some((v) => /^local:/.test(String(v)));
        if (local) return task('qmigrate', `can't migrate local disk '${Object.values(g.config).find((v) => /^local:/.test(String(v)))}': can't live migrate attached local disks without with-local-disks option`);
        if (kind === 'qemu' && g.status === 'running' && form.online !== '1') return task('qmigrate', 'running VM needs online migration');
        if (kind === 'lxc' && g.status === 'running' && form.restart !== '1') return task('vzmigrate', 'running container needs restart mode');
        g.node = target;
        log(`ops: ${kind} ${g.vmid} migrated ${node} -> ${target}`);
        return task(kind === 'qemu' ? 'qmigrate' : 'vzmigrate');
      });
      return true;
    }
    return false;
  }

  const nodeMemory = (name) =>
    16 * GIB + [...guests.values()].filter((g) => g.node === name && g.status === 'running').reduce((sum, g) => sum + g.maxmem, 0);

  /** Cluster-wide routes that follow the state. */
  const routes = {
    '/api2/json/nodes': () => {
      tickAll();
      return Object.entries(nodes).map(([name, n]) => ({
        node: name,
        status: n.online ? 'online' : 'offline',
        cpu: n.online ? 0.05 : 0,
        maxcpu: 32,
        mem: n.online ? nodeMemory(name) : 0,
        maxmem: 128 * GIB,
        disk: 21_474_836_480,
        maxdisk: 107_374_182_400,
        uptime: n.online ? Math.floor((Date.now() - state[name].bootedAt) / 1000) : 0,
        level: '',
      }));
    },
    '/api2/json/cluster/resources': () => {
      tickAll();
      return [
        ...Object.entries(nodes).map(([name, n]) => ({
          id: `node/${name}`,
          type: 'node',
          node: name,
          status: n.online ? 'online' : 'offline',
          maxmem: 128 * GIB,
          mem: n.online ? nodeMemory(name) : 0,
          cpu: n.online ? 0.05 : 0,
          maxcpu: 32,
          uptime: n.online ? Math.floor((Date.now() - state[name].bootedAt) / 1000) : 0,
        })),
        ...[...guests.values()].map((g) => ({
          id: `${g.kind}/${g.vmid}`,
          type: g.kind,
          node: g.node,
          vmid: g.vmid,
          name: g.name,
          status: g.status,
          maxmem: g.maxmem,
          mem: g.status === 'running' ? g.maxmem / 2 : 0,
          maxcpu: 4,
          ...(g.template ? { template: 1 } : {}),
        })),
        ...Object.keys(nodes).flatMap((name) =>
          ['local', 'ceph-vm', 'nfs-iso'].map((st) => ({
            id: `storage/${name}/${st}`,
            type: 'storage',
            node: name,
            storage: st,
            status: nodes[name].online ? 'available' : 'unknown',
            disk: 10 * GIB,
            maxdisk: 1000 * GIB,
            shared: st === 'local' ? 0 : 1,
          })),
        ),
      ];
    },
    ...ceph.routes,
    '/api2/json/cluster/status': () => {
      tickAll();
      return [
        { type: 'cluster', id: 'cluster', name: 'fixture', nodes: Object.keys(nodes).length, quorate: quorate() ? 1 : 0, version: 7 },
        ...Object.entries(nodes).map(([name, n]) => ({
          type: 'node',
          id: `node/${name}`,
          name,
          nodeid: n.nodeid,
          ip: n.ip,
          online: n.online ? 1 : 0,
          local: name === 'pve1' ? 1 : 0,
          level: '',
        })),
      ];
    },
  };

  // -------------------------------------------------------------------------
  // SSH exec
  // -------------------------------------------------------------------------

  /** Answer one exec request; returns false for a command it does not know. */
  function exec(command, channel) {
    const guard = /^\[ "\$\(hostname -s\)" = '?([A-Za-z0-9-]+)'? \] \|\| \{ [^}]*\}; (.*)$/.exec(command);
    if (!guard) {
      log(`EXEC REFUSED (no node guard): ${command}`);
      return false;
    }
    const [, node, rest] = guard;
    const s = state[node];
    if (!s) {
      channel.stderr.write(`velnox: this is not ${node}\n`);
      channel.exit(97);
      channel.end();
      return true;
    }
    tick(node);
    const body = rest.replace(/^sudo -n /, '');
    const done = (code) => {
      channel.exit(code);
      channel.end();
    };

    if (body === 'env LC_ALL=C apt-get -s -o Debug::NoLocking=1 dist-upgrade') {
      log(`ops: ${node} simulate`);
      channel.write('NOTE: This is only a simulation!\n');
      for (const p of [...s.pending, ...ceph.pendingFor(node)]) {
        channel.write(`Inst ${p.Package}${p.OldVersion ? ` [${p.OldVersion}]` : ''} (${p.Version} ${p.archive} [amd64])\n`);
      }
      return (done(0), true);
    }
    if (
      body ===
      "env LC_ALL=C DEBIAN_FRONTEND=noninteractive apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold dist-upgrade"
    ) {
      s.upgrades += 1;
      const all = [...s.pending, ...ceph.pendingFor(node)];
      log(`ops: ${node} dist-upgrade (${all.length} packages)`);
      const lines = [
        'Reading package lists...',
        'Building dependency tree...',
        `${all.length} upgraded, 0 newly installed, 0 to remove and 0 not upgraded.`,
        ...all.flatMap((p) => [`Unpacking ${p.Package} (${p.Version}) ...`, `Setting up ${p.Package} (${p.Version}) ...`]),
      ];
      let i = 0;
      const timer = setInterval(() => {
        if (i < lines.length) {
          channel.write(`${lines[i]}\n`);
          i += 1;
          return;
        }
        clearInterval(timer);
        if (failUpgrade.includes(node)) {
          channel.stderr.write('E: Sub-process /usr/bin/dpkg returned an error code (1)\n');
          return done(100);
        }
        for (const p of s.pending) {
          const kernel = /^proxmox-kernel-(\d+\.\d+\.\d+-\d+)/.exec(p.Package);
          if (kernel) {
            s.kernels.push(kernel[1]);
            s.rebootMarker = true;
          }
        }
        s.pending = [];
        ceph.installAll(node);
        done(0);
      }, 150);
      return true;
    }
    if (body.startsWith("sh -c 'if [ -f /var/run/reboot-required ]")) {
      channel.write(s.rebootMarker ? 'required\nlinux-base\n' : 'no\n');
      return (done(0), true);
    }
    if (ceph.exec(body, node, channel, done)) return true;
    log(`EXEC REFUSED: ${command}`);
    return false;
  }

  return {
    handle,
    handleCluster,
    routes,
    exec,
    version,
    /** Memory in use on a node: 16 GiB for itself, plus its running guests. */
    memoryOf: (name) => ({ total: 128 * GIB, used: nodeMemory(name) }),
    stats: () => ({ state, guests: [...guests.values()], haRules: [...haRules.values()] }),
  };
}

function compare(a, b) {
  const pa = a.split(/[.-]/).map(Number);
  const pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

function readForm(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on('data', (c) => chunks.push(c));
    request.on('end', () => resolve(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()))));
  });
}

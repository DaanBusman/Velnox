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
 */

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

export function installOps({ nodes, storage, log, rebootSeconds = 8, failUpgrade = [] }) {
  const state = {};
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
          pveversion: 'pve-manager/8.2.4/faa83925c9641325',
          cpuinfo: { cpus: 32, sockets: 1, model: 'AMD EPYC 7313P 16-Core Processor' },
          memory: { total: 137_438_953_472, used: 68_719_476_736, free: 68_719_476_736 },
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
        }, 500);
      });
      return true;
    }
    if (!nodes[node].online) return (offline(send, response, node), true);

    if (rest === 'apt/update' && method === 'GET') {
      send(response, 200, {
        data: s.pending.map(({ archive: _archive, ...p }) => ({ ...p, Priority: 'optional', Section: 'admin' })),
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
    return false;
  }

  /** Cluster-wide routes that follow the state. */
  const routes = {
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
      for (const p of s.pending) {
        channel.write(`Inst ${p.Package}${p.OldVersion ? ` [${p.OldVersion}]` : ''} (${p.Version} ${p.archive} [amd64])\n`);
      }
      return (done(0), true);
    }
    if (
      body ===
      "env LC_ALL=C DEBIAN_FRONTEND=noninteractive apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold dist-upgrade"
    ) {
      s.upgrades += 1;
      log(`ops: ${node} dist-upgrade (${s.pending.length} packages)`);
      const lines = [
        'Reading package lists...',
        'Building dependency tree...',
        `${s.pending.length} upgraded, 0 newly installed, 0 to remove and 0 not upgraded.`,
        ...s.pending.flatMap((p) => [`Unpacking ${p.Package} (${p.Version}) ...`, `Setting up ${p.Package} (${p.Version}) ...`]),
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
        done(0);
      }, 150);
      return true;
    }
    if (body.startsWith("sh -c 'if [ -f /var/run/reboot-required ]")) {
      channel.write(s.rebootMarker ? 'required\nlinux-base\n' : 'no\n');
      return (done(0), true);
    }
    log(`EXEC REFUSED: ${command}`);
    return false;
  }

  return { handle, routes, exec, stats: () => state };
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

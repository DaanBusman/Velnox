/**
 * The fixture's Ceph, for the operations mode (Phase 9A).
 *
 * Three monitors, one manager and six OSDs on three nodes, each daemon with
 * the version it runs and each node with the version installed there. The
 * repository decides what apt offers; a dist-upgrade installs it; a daemon
 * runs the new version only once restarted, and is down for a moment while
 * it restarts — a monitor out of quorum, an OSD's placement groups degraded.
 * noout, require-osd-release and min_mon_release behave as Ceph's do.
 *
 * `ops-control.json` can break it on purpose:
 *   `{"cephStart": "17.2.7"}`        every daemon and node starts on that version
 *   `{"cephMixed": true}`            one OSD already runs 19.2.0
 *   `{"cephUnknownWarn": true}`      a warning Velnox does not know
 *   `{"monDown": "pve3"}`            that monitor out of quorum
 *   `{"cephRestartSeconds": 6}`      how long a restarted daemon is down
 *   `{"cephFailRestart": "osd.3"}`   that restart fails
 *   `{"cephReset": 2}`               any new value starts Ceph over
 */

const RELEASES = { 17: 'quincy', 18: 'reef', 19: 'squid' };
const LATEST = { quincy: '17.2.7', reef: '18.2.4', squid: '19.2.0' };
const releaseOf = (version) => RELEASES[Number(String(version).split('.')[0])] ?? 'unknown';
const repoRelease = (line) => (/\/ceph-(\w+) /.exec(line ?? '') ?? [])[1] ?? null;

export function installCeph({ nodes, log, control, storage, extraWarn = () => false }) {
  let state = null;
  let lastReset;

  const fresh = () => {
    const c = control();
    const start = String(c.cephStart ?? '18.2.4');
    const release = releaseOf(start);
    const names = Object.keys(nodes);
    const daemons = [
      ...names.map((n) => ({ name: `mon.${n}`, kind: 'mon', host: n, id: n, running: start, downUntil: 0 })),
      { name: `mgr.${names[0]}`, kind: 'mgr', host: names[0], id: names[0], running: start, downUntil: 0 },
      ...names.flatMap((n, i) =>
        [0, 1].map((k) => ({ name: `osd.${i * 2 + k}`, kind: 'osd', host: n, id: i * 2 + k, running: start, downUntil: 0 })),
      ),
    ];
    if (c.cephMixed) daemons.find((d) => d.name === 'osd.1').running = '19.2.0';
    state = {
      daemons,
      installed: Object.fromEntries(names.map((n) => [n, start])),
      repo: Object.fromEntries(names.map((n) => [n, `deb http://download.proxmox.com/debian/ceph-${release} bookworm no-subscription`])),
      noout: false,
      requireOsdRelease: release,
    };
    log(`ceph: fresh at ${start}`);
  };
  const current = () => {
    const c = control();
    if (!state || c.cephReset !== lastReset) {
      lastReset = c.cephReset;
      fresh();
    }
    return state;
  };

  const now = () => Date.now();
  const down = (d) => d.downUntil > now();

  const health = () => {
    const s = current();
    const c = control();
    const checks = {};
    const warn = (code, message) => (checks[code] = { severity: 'HEALTH_WARN', summary: { message } });
    const monsDown = s.daemons.filter((d) => d.kind === 'mon' && (down(d) || c.monDown === d.id));
    if (monsDown.length) warn('MON_DOWN', `${monsDown.length}/3 mons down, quorum ${s.daemons.filter((d) => d.kind === 'mon' && !monsDown.includes(d)).map((d) => d.id).join(',')}`);
    const osdsDown = s.daemons.filter((d) => d.kind === 'osd' && down(d));
    if (osdsDown.length) {
      warn('OSD_DOWN', `${osdsDown.length} osds down`);
      warn('PG_DEGRADED', 'Degraded data redundancy: 120 objects degraded');
    }
    if (s.noout) warn('OSDMAP_FLAGS', 'noout flag(s) set');
    const osds = s.daemons.filter((d) => d.kind === 'osd');
    const lowest = Math.min(...osds.map((d) => Number(d.running.split('.')[0])));
    const required = Object.entries(RELEASES).find(([, r]) => r === s.requireOsdRelease)?.[0];
    if (lowest > Number(required)) warn('OSD_UPGRADE_FINISHED', `all OSDs are running ${RELEASES[lowest]} or later but require_osd_release < ${RELEASES[lowest]}`);
    if (c.cephUnknownWarn) warn('DEVICE_HEALTH', '1 device has a predicted failure');
    // The rolling-update harness's Ceph that turns unhealthy after a reboot.
    if (extraWarn()) warn('OSD_DOWN', '2 osds down');
    return { checks, monsDown, osdsDown };
  };

  const routes = {
    '/api2/json/cluster/ceph/status': () => {
      const s = current();
      const { checks, monsDown, osdsDown } = health();
      const mons = s.daemons.filter((d) => d.kind === 'mon');
      const minMon = Math.min(...mons.map((d) => Number(d.running.split('.')[0])));
      return {
        fsid: '9f2b8a54-0a11-4f0c-9d8e-5b1a2c3d4e5f',
        health: { status: Object.keys(checks).length ? 'HEALTH_WARN' : 'HEALTH_OK', checks },
        monmap: { mons: mons.map((d) => ({ name: d.id })), min_mon_release_name: RELEASES[minMon] },
        quorum_names: mons.filter((d) => !monsDown.includes(d)).map((d) => d.id),
        osdmap: { osdmap: { num_osds: 6, num_up_osds: 6 - osdsDown.length, num_in_osds: 6, flags: s.noout ? 'noout' : '' } },
        pgmap: {
          num_pgs: 257,
          pgs_by_state: osdsDown.length
            ? [
                { state_name: 'active+clean', count: 217 },
                { state_name: 'active+undersized+degraded', count: 40 },
              ]
            : [{ state_name: 'active+clean', count: 257 }],
          bytes_used: 1e12,
          bytes_total: 1e13,
        },
      };
    },
    '/api2/json/cluster/ceph/metadata': () => {
      const s = current();
      const entry = (d) => ({ name: d.kind === 'osd' ? undefined : d.id, id: d.kind === 'osd' ? d.id : undefined, hostname: d.host, ceph_version_short: d.running });
      const of = (kind) => Object.fromEntries(s.daemons.filter((d) => d.kind === kind).map((d) => [String(d.id), entry(d)]));
      return { mon: of('mon'), mgr: of('mgr'), osd: of('osd') };
    },
    '/api2/json/cluster/ceph/flags': () => [
      { name: 'noout', value: current().noout ? 1 : 0, description: 'OSDs will not be marked out automatically' },
      { name: 'nobackfill', value: 0, description: 'Backfilling of PGs is suspended' },
    ],
  };

  /** PUT /cluster/ceph/flags/{flag}. */
  function handleCluster(request, response, path, send, readForm) {
    const match = /^\/api2\/json\/cluster\/ceph\/flags\/(\w+)$/.exec(path);
    if (!match || request.method !== 'PUT') return false;
    readForm(request).then((form) => {
      if (match[1] !== 'noout') return send(response, 400, { data: null, message: `flag ${match[1]} not modelled` });
      current().noout = String(form.value) === '1';
      log(`ceph: noout ${current().noout ? 'set' : 'unset'}`);
      send(response, 200, { data: null });
    });
    return true;
  }

  /** POST /nodes/{node}/ceph/restart service=…. */
  function handleNode(request, response, node, rest, send, readForm) {
    if (rest !== 'ceph/restart' || request.method !== 'POST') return false;
    readForm(request).then((form) => {
      const s = current();
      const d = s.daemons.find((x) => x.name === form.service);
      const task = (error) =>
        send(response, 200, {
          data: storage.newTask(node, 'srvrestart', error ? `command failed: ${error}` : 'OK', error ? [error] : ['TASK OK']),
        });
      if (!d || d.host !== node) return task(`no such service '${form.service}' on ${node}`);
      if (control().cephFailRestart === d.name) {
        log(`ceph: restart ${d.name} FAILED (on purpose)`);
        return task(`Job for ceph-${d.kind}@${d.id}.service failed`);
      }
      const before = d.running;
      d.running = s.installed[node];
      d.downUntil = now() + Number(control().cephRestartSeconds ?? 2) * 1000;
      log(`ceph: restart ${d.name} ${before} -> ${d.running}`);
      return task(null);
    });
    return true;
  }

  /** What apt offers for Ceph on a node: the repository's release, if newer than installed. */
  function pendingFor(node) {
    const s = current();
    const release = repoRelease(s.repo[node]);
    const offered = release ? LATEST[release] : null;
    if (!offered || Number(offered.split('.')[0]) <= Number(s.installed[node].split('.')[0])) return [];
    return ['ceph-common', 'ceph-mon', 'ceph-osd'].map((Package) => ({
      Package,
      OldVersion: `${s.installed[node]}-pve1`,
      Version: `${offered}-pve1`,
      Origin: 'Proxmox',
      archive: `Proxmox:bookworm/${release}`,
    }));
  }
  function installAll(node) {
    const pending = pendingFor(node);
    if (!pending.length) return;
    current().installed[node] = pending[0].Version.replace(/-pve\d+$/, '');
    log(`ceph: ${node} has ${current().installed[node]} installed`);
  }

  /** SSH: the repository written, require-osd-release raised. */
  function exec(body, node, channel, done) {
    const s = current();
    if (body.startsWith('sh -c ') && body.includes('/etc/apt/sources.list.d/ceph.list')) {
      const line = /(deb https?:\/\/[^\s']+ \w+ [\w-]+)/.exec(body)?.[1];
      if (!line) return false;
      s.repo[node] = line;
      log(`ceph: ${node} repository ${line}`);
      channel.write(`${line}\n`);
      return (done(0), true);
    }
    const require = /^ceph osd require-osd-release (\w+)$/.exec(body);
    if (require) {
      const target = require[1];
      const behind = s.daemons.filter((d) => d.kind === 'osd' && releaseOf(d.running) !== target);
      if (behind.length) {
        channel.stderr.write(`Error EPERM: not all up OSDs have CEPH_FEATURE_SERVER_${target.toUpperCase()} feature\n`);
        return (done(1), true);
      }
      s.requireOsdRelease = target;
      log(`ceph: require_osd_release ${target}`);
      return (done(0), true);
    }
    return false;
  }

  return { routes, handleCluster, handleNode, pendingFor, installAll, exec, stats: () => current() };
}

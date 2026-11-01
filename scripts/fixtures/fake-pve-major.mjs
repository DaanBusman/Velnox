/**
 * The fixture's Proxmox VE 8 → 9 (Phase 9B), for the operations mode.
 *
 * Each node has a Proxmox VE version, its apt sources, and the things
 * pve8to9 looks at: the CPU vendor and whether its microcode package is
 * installed, settings in /etc/sysctl.conf, the systemd-boot meta-package,
 * free space on /. `pve8to9 --full` answers from that state, with
 * pve8to9.pm's own messages; the remediations Velnox runs change it. With its
 * sources on trixie, a dist-upgrade installs PVE 9 and its kernel; the node
 * runs them after a reboot.
 *
 * `ops-control.json`:
 *   `{"pve": "8.4.1"}`              the version every node starts on (8.2.4 otherwise);
 *                                   below 8.4.2 there is no pve8to9, as on a real node
 *   `{"pve8Latest": "8.4.14"}`      apt on bookworm offers that pve-manager (nothing otherwise)
 *   `{"microcode": true}`           microcode already installed
 *   `{"cpuVendor": "AuthenticAMD"}` the CPU (GenuineIntel otherwise)
 *   `{"sysctlConf": false}`         /etc/sysctl.conf holds only comments
 *   `{"systemdBoot": true}`         the systemd-boot meta-package installed
 *   `{"rootFreeGb": 3}`             free space on /
 *   `{"pve8to9Unknown": "…"}`       pve8to9 prints that line, unprefixed
 *   `{"pveNine": ["pve3"]}`         those nodes already run Proxmox VE 9, on trixie
 *   `{"majorReset": 1}`             any new value starts the nodes over
 *
 * With `{"cephAbsent": true}` each node also has the Ceph repository Proxmox VE 8
 * ships even where Ceph was never set up, on ceph-quincy. Moved to trixie
 * without first moving to Squid, `apt-get update` fails with exit code 100, as
 * on a real node: Ceph publishes only Squid for trixie.
 */

const PVE9 = '9.0.10';
/** The first pve-manager with pve8to9 in it. */
const PVE8TO9_FROM = '8.4.2';
const older = (a, b) => a.localeCompare(b, undefined, { numeric: true }) < 0;
const KERNEL9 = '6.14.11-2';
const SYSCTL_SETTINGS = '# /etc/sysctl.conf - Configuration file for setting system variables\n#\nnet.ipv4.ip_forward=1\nvm.swappiness=10\n';
const SYSCTL_COMMENTS = '# /etc/sysctl.conf - Configuration file for setting system variables\n#\n';

export function installMajor({ nodes, log, control }) {
  let state = null;
  let lastReset;

  const fresh = () => {
    const c = control();
    const nine = [].concat(c.pveNine ?? []);
    state = Object.fromEntries(
      Object.keys(nodes).map((n) => [
        n,
        nine.includes(n) ? alreadyNine() : {
          // Null until the node is upgraded: until then it follows the control file.
          pve: null,
          installedPve: null,
          sources: 'deb http://deb.debian.org/debian bookworm main contrib\ndeb http://deb.debian.org/debian bookworm-updates main contrib\ndeb http://security.debian.org/debian-security bookworm-security main contrib\n',
          pveRepo: 'deb http://download.proxmox.com/debian/pve bookworm pve-no-subscription\n',
          cephRepo: 'deb http://download.proxmox.com/debian/ceph-quincy bookworm no-subscription\n',
          microcode: Boolean(c.microcode),
          vendor: String(c.cpuVendor ?? 'GenuineIntel'),
          sysctl: c.sysctlConf === false ? SYSCTL_COMMENTS : SYSCTL_SETTINGS,
          sysctlD: {},
          systemdBoot: Boolean(c.systemdBoot),
          rootFreeGb: Number(c.rootFreeGb ?? 40),
          kernel9Installed: false,
        },
      ]),
    );
    log(`major: fresh at ${String(c.pve ?? '8.2.4')}`);
  };
  /** A node upgraded before Velnox saw it: 9 installed and running, its sources on trixie. */
  const alreadyNine = () => ({
    pve: PVE9,
    installedPve: PVE9,
    sources: [
      'deb http://deb.debian.org/debian trixie main contrib',
      'deb http://deb.debian.org/debian trixie-updates main contrib',
      'deb http://security.debian.org/debian-security trixie-security main contrib',
      '',
    ].join('\n'),
    pveRepo: 'deb http://download.proxmox.com/debian/pve trixie pve-no-subscription\n',
    cephRepo: 'deb http://download.proxmox.com/debian/ceph-squid trixie no-subscription\n',
    microcode: true,
    vendor: 'GenuineIntel',
    sysctl: SYSCTL_COMMENTS,
    sysctlD: {},
    systemdBoot: false,
    rootFreeGb: 40,
    kernel9Installed: true,
  });
  const current = () => {
    const c = control();
    if (!state || c.majorReset !== lastReset) {
      lastReset = c.majorReset;
      fresh();
    }
    return state;
  };

  const pveOf = (s) => s.pve ?? String(control().pve ?? '8.2.4');
  const microcodePkg = (s) => (s.vendor === 'AuthenticAMD' ? 'amd64-microcode' : 'intel-microcode');
  const onTrixie = (s) => /\btrixie\b/.test(s.sources) && /\btrixie\b/.test(s.pveRepo);
  const sysctlHasSettings = (s) => s.sysctl.split('\n').some((l) => l.trim() && !/^\s*[#;]/.test(l));

  /** pve8to9 --full, as pve8to9.pm prints it, from the node's state. */
  function pve8to9(node, { cephRelease, offline }) {
    const s = current()[node];
    const lines = [];
    const counters = { pass: 0, skip: 0, notice: 0, warn: 0, fail: 0 };
    const log2 = (level, text) => {
      if (level in counters) counters[level] += 1;
      lines.push(`${level.toUpperCase()}: ${text}`);
    };
    const header = (h) => lines.push(...(lines.length ? [''] : []), `= ${h} =`, '');
    const upgraded = pveOf(s).startsWith('9.');

    header('CHECKING VERSION INFORMATION FOR PVE PACKAGES');
    lines.push('Checking for package updates..');
    log2('pass', 'all packages up-to-date');
    lines.push('', 'Checking proxmox-ve package version..');
    if (upgraded) log2('pass', 'already upgraded to Proxmox VE 9');
    else if (pveOf(s).localeCompare('8.4.0', undefined, { numeric: true }) >= 0) log2('pass', 'proxmox-ve package has version >= 8.4-0');
    else log2('fail', 'proxmox-ve package is too old, please upgrade to >= 8.4-0!');

    header('CHECKING CLUSTER HEALTH/SETTINGS');
    log2('pass', 'Cluster Filesystem is quorate.');
    if (offline > 0) log2('fail', `${offline} nodes are offline!`);

    header('CHECKING HYPER-CONVERGED CEPH STATUS');
    if (!cephRelease) log2('skip', 'no hyper-converged ceph setup detected!');
    else if (cephRelease !== 'squid' && !upgraded) {
      log2('fail', `Hyper-converged Ceph ${cephRelease === 'reef' ? '18 Reef' : cephRelease} is to old for upgrade!\nUpgrade Ceph first to Squid following our how-to:\n<https://pve.proxmox.com/wiki/Category:Ceph_Upgrade>`);
    } else log2('pass', 'found expected Ceph 19 Squid release.');

    header('MISCELLANEOUS CHECKS');
    // A line no parser version knows, printed where nothing can claim it.
    if (control().pve8to9Unknown) lines.push(String(control().pve8to9Unknown));
    if (s.rootFreeGb < 5) log2('warn', 'Less than 5 GB free space on root file system, upgrade may fail.');
    else if (s.rootFreeGb < 10) log2('notice', 'Less than 10 GB free space on root file system.');
    log2('info', 'Checking bootloader configuration...');
    if (s.systemdBoot) {
      log2('fail', "systemd-boot meta-package installed. This will cause problems on upgrades of other boot-related packages. Remove 'systemd-boot' See https://pve.proxmox.com/wiki/Upgrade_from_8_to_9#sd-boot-warning for more information.");
    } else log2('pass', 'bootloader packages installed correctly');
    log2('info', "Checking if the legacy sysctl file '/etc/sysctl.conf' needs to be migrated to new '/etc/sysctl.d/' path.");
    if (sysctlHasSettings(s)) log2('warn', "Deprecated config '/etc/sysctl.conf' contains settings - move them to a dedicated file in '/etc/sysctl.d/'.");
    else log2('pass', "Legacy file '/etc/sysctl.conf' is not present or contains no settings.");
    log2('info', 'Checking if matching CPU microcode package is installed.');
    const pkg = microcodePkg(s);
    if (s.microcode) log2('pass', `Found matching CPU microcode package '${pkg}' installed.`);
    else {
      log2(
        'warn',
        `The matching CPU microcode package '${pkg}' could not be found! Consider installing it to receive the latest security and bug fixes for your CPU.\n\tEnsure you enable the 'non-free-firmware' component in the apt sources and run:\n\tapt install ${pkg}`,
      );
    }

    header('SUMMARY');
    const total = Object.values(counters).reduce((a, b) => a + b, 0);
    lines.push(`TOTAL:    ${total}`, `PASSED:   ${counters.pass}`, `SKIPPED:  ${counters.skip}`, `WARNINGS: ${counters.warn}`, `FAILURES: ${counters.fail}`);
    if (counters.warn || counters.fail) lines.push('', 'ATTENTION: Please check the output for detailed information!');
    return `${lines.join('\n')}\n`;
  }

  /** SSH commands; returns false for one it does not know. */
  function exec(body, node, channel, done, context) {
    const s = current()[node];
    if (!s) return false;
    const ok = (out = '') => {
      if (out) channel.write(out);
      done(0);
      return true;
    };
    if (body === 'pve8to9 --full') {
      if (!pveOf(s).startsWith('9.') && older(pveOf(s), PVE8TO9_FROM)) {
        channel.stderr.write('bash: line 1: pve8to9: command not found\n');
        done(127);
        return true;
      }
      return ok(pve8to9(node, context));
    }
    if (body === 'cat /etc/sysctl.conf') return ok(s.sysctl);
    if (body.includes('apt-get install -y intel-microcode') || body.includes('apt-get install -y amd64-microcode')) {
      if (!/non-free-firmware/.test(body)) return false;
      s.sources = s.sources.replace(/^(deb .*(?:deb|security)\.debian\.org.*?)$/gm, (l) => (l.includes('non-free-firmware') ? l : `${l} non-free-firmware`));
      s.microcode = true;
      log(`major: ${node} microcode installed, sources now ${s.sources.trim().split('\n').length} lines with non-free-firmware`);
      return ok('Setting up intel-microcode ...\n');
    }
    if (body.includes('sysctl.conf.velnox-before')) {
      const settings = s.sysctl.split('\n').filter((l) => l.trim() && !/^\s*[#;]/.test(l));
      s.sysctlD['99-velnox-from-sysctl-conf.conf'] = `${settings.join('\n')}\n`;
      s.sysctl = s.sysctl
        .split('\n')
        .map((l) => (l.trim() && !/^\s*[#;]/.test(l) ? `# moved to /etc/sysctl.d/99-velnox-from-sysctl-conf.conf: ${l}` : l))
        .join('\n');
      log(`major: ${node} sysctl settings moved`);
      return ok();
    }
    if (/apt-get -y remove systemd-boot$/.test(body)) {
      s.systemdBoot = false;
      log(`major: ${node} systemd-boot removed`);
      return ok('Removing systemd-boot ...\n');
    }
    if (body.includes('.velnox-ceph') && body.includes('ceph-squid')) {
      s.cephRepo = s.cephRepo.replace(/\/debian\/ceph-[a-z]+/g, '/debian/ceph-squid');
      log(`major: ${node} ceph repository on squid`);
      return ok(s.cephRepo);
    }
    if (body.includes('.velnox-bookworm') && body.includes('trixie')) {
      s.sources = s.sources.replace(/\bbookworm\b/g, 'trixie');
      s.pveRepo = s.pveRepo.replace(/\bbookworm\b/g, 'trixie');
      s.cephRepo = s.cephRepo.replace(/\bbookworm\b/g, 'trixie');
      log(`major: ${node} sources on trixie`);
      return ok();
    }
    return false;
  }

  /** The newest Proxmox VE 8 apt offers on bookworm, if the control file names one. */
  const latest8 = (s) => {
    const latest = control().pve8Latest ? String(control().pve8Latest) : null;
    return latest && !onTrixie(s) && older(pveOf(s), latest) ? latest : null;
  };

  /** What apt offers: the latest PVE 8 on bookworm, PVE 9 once the sources are on trixie. */
  function pendingFor(node) {
    const s = current()[node];
    const latest = latest8(s);
    if (latest) {
      return [{ Package: 'pve-manager', OldVersion: pveOf(s), Version: latest, Origin: 'Proxmox', archive: 'Proxmox:bookworm/pve-no-subscription' }];
    }
    if (!onTrixie(s) || (s.installedPve ?? pveOf(s)).startsWith('9.')) return [];
    return [
      { Package: 'pve-manager', OldVersion: s.installedPve ?? pveOf(s), Version: PVE9, Origin: 'Proxmox', archive: 'Proxmox:trixie/pve-no-subscription' },
      { Package: `proxmox-kernel-${KERNEL9}-pve-signed`, OldVersion: null, Version: KERNEL9, Origin: 'Proxmox', archive: 'Proxmox:trixie/pve-no-subscription' },
    ];
  }
  function installAll(node) {
    const s = current()[node];
    if (!pendingFor(node).length) return null;
    const latest = latest8(s);
    if (latest) {
      // Within 8, pveversion reports the new pve-manager at once: no reboot needed.
      s.pve = latest;
      log(`major: ${node} updated within Proxmox VE 8 to ${latest}`);
      return null;
    }
    s.installedPve = PVE9;
    s.kernel9Installed = true;
    log(`major: ${node} has PVE ${PVE9} installed`);
    return KERNEL9;
  }
  /** A reboot runs what is installed. */
  function rebooted(node) {
    const s = current()[node];
    if (s.installedPve && s.installedPve !== s.pve) {
      s.pve = s.installedPve;
      log(`major: ${node} runs PVE ${s.pve}`);
    }
  }

  /** apt-get update's output when it fails, as apt prints it; null when it does not. */
  function aptRefusal(node) {
    const s = current()[node];
    if (!s || !control().cephAbsent) return null;
    const release = /\/debian\/(ceph-[a-z]+) trixie/.exec(s.cephRepo)?.[1];
    if (!release || release === 'ceph-squid') return null;
    return [
      `Ign:5 http://download.proxmox.com/debian/${release} trixie InRelease`,
      `Err:6 http://download.proxmox.com/debian/${release} trixie Release`,
      '  404  Not Found [IP: 212.224.123.70 80]',
      `E: The repository 'http://download.proxmox.com/debian/${release} trixie Release' does not have a Release file.`,
    ];
  }

  return { exec, pendingFor, installAll, rebooted, aptRefusal, versionOf: (node) => current()[node]?.pve ?? null, stats: () => current() };
}

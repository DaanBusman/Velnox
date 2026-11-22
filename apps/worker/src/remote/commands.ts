/**
 * The commands Velnox runs on a node over SSH, and nothing else (ADR-046).
 *
 * A command is a `CommandSpec` from this registry: a fixed argv, whether it
 * changes the node, whether it needs root, how long it may take, and whether a
 * cancelled job may interrupt it. No HTTP endpoint, job parameter or setting
 * supplies a command or an argument that ends up in one — the only value that
 * varies is the node's name, checked against Proxmox's own rule before use.
 *
 * Every command is wrapped the same way:
 *
 *   [ "$(hostname -s)" = 'pve1' ] || { echo …; exit 97; }; [sudo -n] env LC_ALL=C …
 *
 * The guard makes a command refuse to run on any machine but the node it was
 * meant for, by name — the host key already proved it is the machine Velnox
 * confirmed, and this proves it is the node the job is about. `LC_ALL=C` makes
 * the output the one the parsers were written against. `sudo -n` is added for
 * a privileged command when the account is not root, and fails rather than
 * prompts when sudo would ask for a password.
 */

export interface CommandSpec {
  id: string;
  /** Changes nothing on the node. */
  readOnly: boolean;
  /** Needs root. */
  privileged: boolean;
  timeoutMs: number;
  /**
   * Whether a cancelled job may stop it. A dist-upgrade may not: dpkg
   * interrupted mid-transaction is a node someone has to repair by hand.
   */
  interruptible: boolean;
  argv: readonly string[];
}

import {
  CEPH_CHANNELS,
  CEPH_MATRIX,
  CEPH_RELEASE_NAMES,
  cephRepoLine,
  type CephChannel,
  type CephMatrixEntry,
  type CephRelease,
  type ChangeSet,
} from '@velnox/shared';

const MINUTE = 60_000;

export const COMMANDS = {
  /** What a dist-upgrade would do, without doing it. Readable as any user. */
  aptSimulate: {
    id: 'apt.simulate',
    readOnly: true,
    privileged: false,
    timeoutMs: 3 * MINUTE,
    interruptible: true,
    argv: ['env', 'LC_ALL=C', 'apt-get', '-s', '-o', 'Debug::NoLocking=1', 'dist-upgrade'],
  },
  /**
   * Apply every pending update, keeping the node's own configuration files
   * where a package ships a new one — as Proxmox's own upgrade advice says.
   */
  aptDistUpgrade: {
    id: 'apt.dist_upgrade',
    readOnly: false,
    privileged: true,
    timeoutMs: 90 * MINUTE,
    interruptible: false,
    argv: [
      'env',
      'LC_ALL=C',
      'DEBIAN_FRONTEND=noninteractive',
      'apt-get',
      '-y',
      '-o',
      'Dpkg::Options::=--force-confdef',
      '-o',
      'Dpkg::Options::=--force-confold',
      'dist-upgrade',
    ],
  },
  /**
   * What `apt-get autoremove` would remove, without removing it — read first,
   * so a removal that would take the running kernel or Proxmox itself is
   * refused before anything is gone.
   */
  aptAutoremoveSimulate: {
    id: 'apt.autoremove_simulate',
    readOnly: true,
    privileged: false,
    timeoutMs: 3 * MINUTE,
    interruptible: true,
    argv: ['env', 'LC_ALL=C', 'apt-get', '-s', '-o', 'Debug::NoLocking=1', 'autoremove'],
  },
  /**
   * Remove the packages nothing depends on any more — old kernels, mostly.
   * Not `--purge`: their configuration files stay, as apt's own default does.
   * Not interruptible, for the same reason as the dist-upgrade.
   */
  aptAutoremove: {
    id: 'apt.autoremove',
    readOnly: false,
    privileged: true,
    timeoutMs: 30 * MINUTE,
    interruptible: false,
    argv: [
      'env',
      'LC_ALL=C',
      'DEBIAN_FRONTEND=noninteractive',
      'apt-get',
      '-y',
      '-o',
      'Dpkg::Options::=--force-confdef',
      '-o',
      'Dpkg::Options::=--force-confold',
      'autoremove',
    ],
  },
  /** Debian's own marker that something installed wants a reboot. */
  rebootRequired: {
    id: 'system.reboot_required',
    readOnly: true,
    privileged: false,
    timeoutMs: MINUTE,
    interruptible: true,
    argv: [
      'sh',
      '-c',
      'if [ -f /var/run/reboot-required ]; then echo required; cat /var/run/reboot-required.pkgs 2>/dev/null; else echo no; fi',
    ],
  },
} as const satisfies Record<string, CommandSpec>;

export type CommandId = keyof typeof COMMANDS;

/**
 * Ceph's commands (Phase 9A), one fixed spec per matrix entry and channel and
 * per release — generated here from the version matrix, which is code, so the
 * registry stays closed: no plan, request or setting supplies a line of them.
 */
const CEPH_LIST = '/etc/apt/sources.list.d/ceph.list';

export function cephRepoCommand(entry: CephMatrixEntry, channel: CephChannel): CommandSpec {
  const line = cephRepoLine(entry, channel);
  return {
    id: `ceph.repository.${entry.to}.${channel}`,
    readOnly: false,
    privileged: true,
    timeoutMs: MINUTE,
    interruptible: true,
    argv: [
      'sh',
      '-c',
      `cp -p ${CEPH_LIST} ${CEPH_LIST}.velnox-before 2>/dev/null; printf '%s\\n' '${line}' > ${CEPH_LIST} && cat ${CEPH_LIST}`,
    ],
  };
}

export function cephRequireReleaseCommand(release: CephRelease): CommandSpec {
  return {
    id: `ceph.require_osd_release.${release}`,
    readOnly: false,
    privileged: true,
    timeoutMs: 2 * MINUTE,
    interruptible: true,
    argv: ['ceph', 'osd', 'require-osd-release', release],
  };
}

/** Every Ceph command there can be — for the documentation and its sudoers lines. */
export const CEPH_COMMANDS: readonly CommandSpec[] = [
  ...CEPH_MATRIX.flatMap((entry) =>
    CEPH_CHANNELS.map((channel) => cephRepoCommand(entry, channel)),
  ),
  ...CEPH_RELEASE_NAMES.map(cephRequireReleaseCommand),
];

/**
 * The Proxmox VE 8 → 9 upgrade's commands (Phase 9B): pve8to9 itself, and
 * one fixed command per remediation Velnox offers for its findings. Each keeps
 * a copy of what it changes, as `*.velnox-before`.
 */
const SYSCTL_D = '/etc/sysctl.d/99-velnox-from-sysctl-conf.conf';
const APT = ['env', 'LC_ALL=C', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', '-y'] as const;
/** dpkg's own field, kept out of the templates below where it would read as interpolation. */
const DPKG_STATUS = '${db:Status-Abbrev}';
const PROXMOX_KERNEL = "'^ii +(proxmox|pve)-kernel-[0-9]+\\.[0-9]+\\.[0-9]+-[0-9]+-pve'";

/** Where a node's own NTP servers go: Debian's chrony reads this directory. */
export const CHRONY_SOURCES = '/etc/chrony/sources.d/velnox-from-timesyncd.sources';
/** The first copy of each file the retention change touches; not in /etc/pve, which is shared. */
export const MAXFILES_BACKUP = '/root/velnox-before-maxfiles';

/**
 * chrony in place of systemd-timesyncd. Debian's two packages conflict, so
 * installing one removes the other. The node's own NTP servers are read first
 * and added as preferred sources in a file of their own: chrony.conf stays as
 * the package shipped it, so the dist-upgrade to trixie has nothing to ask
 * about it. When chrony does not synchronise, timesyncd is put back.
 */
const CHRONY_SCRIPT = [
  'set -u',
  `sources=${CHRONY_SOURCES}`,
  'export DEBIAN_FRONTEND=noninteractive',
  'servers=$(timedatectl show-timesync --property=SystemNTPServers --property=LinkNTPServers --value) || { echo "velnox: the NTP servers of systemd-timesyncd could not be read" >&2; exit 1; }',
  'for s in $servers; do case "$s" in -*|*[!A-Za-z0-9.:-]*) echo "velnox: not an NTP server: $s" >&2; exit 1;; esac; done',
  'back() { rm -f "$sources"; apt-get -y install systemd-timesyncd >/dev/null 2>&1 || echo "velnox: systemd-timesyncd could not be put back" >&2; }',
  'apt-get -y install chrony || { back; echo "velnox: chrony could not be installed" >&2; exit 1; }',
  'if [ -n "$servers" ]; then',
  "  for s in $servers; do printf 'server %s iburst prefer\\n' \"$s\"; done | sort -u > \"$sources\"",
  '  chronyc reload sources >/dev/null 2>&1 || systemctl restart chrony',
  'fi',
  'if ! chronyc waitsync 12 0 0 5 >/dev/null; then back; echo "velnox: chrony did not synchronise within a minute; systemd-timesyncd is back" >&2; exit 1; fi',
].join('\n');

/**
 * The meta-package Proxmox's guide says to remove on a node installed on plain
 * Debian. Refuses unless the node runs a Proxmox kernel, has one installed,
 * and apt would remove this one package and nothing else.
 */
const REMOVE_LINUX_IMAGE_SCRIPT = [
  'set -eu',
  'case "$(uname -r)" in *-pve) ;; *) echo "velnox: the running kernel is not a Proxmox kernel" >&2; exit 1;; esac',
  `dpkg-query -W -f='${DPKG_STATUS} \${Package}\\n' 'proxmox-kernel-*' 'pve-kernel-*' 2>/dev/null | grep -Eq ${PROXMOX_KERNEL} || { echo "velnox: no Proxmox kernel is installed" >&2; exit 1; }`,
  "removes=$(apt-get -s -o Debug::NoLocking=1 remove linux-image-amd64 | sed -n 's/^Remv \\([^ ]*\\).*/\\1/p')",
  '[ "$removes" = linux-image-amd64 ] || { echo "velnox: removing it would also remove: $removes" >&2; exit 1; }',
  'DEBIAN_FRONTEND=noninteractive apt-get -y remove linux-image-amd64',
].join('\n');

/**
 * `maxfiles` to `prune-backups`, in the three places pve8to9 looks. One script
 * for showing and for doing, so what is approved is what runs. It prints one
 * tab-separated line per change: where, before, after. The mapping is
 * vzdump's own: N keeps the last N, 0 keeps everything, and an existing
 * `prune-backups` already wins, so there only `maxfiles` goes.
 */
const maxfilesScript = (apply: boolean) =>
  [
    'set -eu',
    `apply=${apply ? 1 : 0}`,
    `keep=${MAXFILES_BACKUP}`,
    "t=''",
    "trap 'rm -f \"$t\"' EXIT",
    'die() { echo "velnox: $1" >&2; exit 1; }',
    'value() { case "$1" in \'\'|*[!0-9]*|0?*) return 1;; 0) echo keep-all=1;; *) echo "keep-last=$1";; esac; }',
    "row() { printf '%s\\t%s\\t%s\\n' \"$1\" \"$2\" \"$3\"; }",
    'save() { if [ "$apply" = 1 ]; then mkdir -p "$keep"; [ -e "$keep/$2" ] || cp -p "$1" "$keep/$2"; fi; }',
    // This node's /etc/vzdump.conf.
    'c=/etc/vzdump.conf',
    "if [ -f \"$c\" ] && grep -Eq '^[[:space:]]*maxfiles:' \"$c\"; then",
    "  [ \"$(grep -Ec '^[[:space:]]*maxfiles:' \"$c\")\" = 1 ] || die \"$c has more than one maxfiles line\"",
    "  n=$(sed -nE 's/^[[:space:]]*maxfiles:[[:space:]]*([^[:space:]]*)[[:space:]]*$/\\1/p' \"$c\")",
    '  v=$(value "$n") || die "$c: maxfiles is not a number: $n"',
    "  if grep -Eq '^[[:space:]]*prune-backups:' \"$c\"; then",
    '    row "$c" "maxfiles: $n" "(removed: prune-backups is already set)"',
    "    if [ \"$apply\" = 1 ]; then save \"$c\" vzdump.conf; sed -i -E '/^[[:space:]]*maxfiles:/d' \"$c\"; fi",
    '  else',
    '    row "$c" "maxfiles: $n" "prune-backups: $v"',
    '    if [ "$apply" = 1 ]; then save "$c" vzdump.conf; sed -i -E "s|^[[:space:]]*maxfiles:.*|prune-backups: $v|" "$c"; fi',
    '  fi',
    'fi',
    // The cluster's storages, through Proxmox's own tool.
    's=/etc/pve/storage.cfg',
    'if [ -f "$s" ]; then',
    "  awk '/^[a-z0-9]+:[[:space:]]/ { if (id != \"\" && m != \"\") print id, m, p; id=$2; m=\"\"; p=0; next } /^[[:space:]]+maxfiles[[:space:]]/ { m=$2 } /^[[:space:]]+prune-backups[[:space:]]/ { p=1 } END { if (id != \"\" && m != \"\") print id, m, p }' \"$s\" | while read -r id n has; do",
    '    case "$id" in -*|*[!A-Za-z0-9._-]*) die "not a storage name: $id";; esac',
    '    v=$(value "$n") || die "storage $id: maxfiles is not a number: $n"',
    '    if [ "$has" = 1 ]; then',
    '      row "storage $id" "maxfiles $n" "(removed: prune-backups is already set)"',
    '      if [ "$apply" = 1 ]; then save "$s" storage.cfg; pvesm set "$id" --delete maxfiles; fi',
    '    else',
    '      row "storage $id" "maxfiles $n" "prune-backups $v"',
    '      if [ "$apply" = 1 ]; then save "$s" storage.cfg; pvesm set "$id" --prune-backups "$v" --delete maxfiles; fi',
    '    fi',
    '  done',
    'fi',
    // The old cron file, shared by the cluster: written in place, as /etc/pve wants.
    'j=/etc/pve/vzdump.cron',
    "if [ -f \"$j\" ] && grep -Eq '^[^#]*--maxfiles[ =]' \"$j\"; then",
    '  t=$(mktemp)',
    `  awk '/^[[:space:]]*#/ { print; next } { line = $0; if (match(line, /--maxfiles[ =]+[0-9]+/)) { n = substr(line, RSTART, RLENGTH); sub(/^--maxfiles[ =]+/, "", n); if (line ~ /--prune-backups/) line = substr(line, 1, RSTART - 2) substr(line, RSTART + RLENGTH); else line = substr(line, 1, RSTART - 1) "--prune-backups " (n == "0" ? "keep-all=1" : "keep-last=" (n + 0)) substr(line, RSTART + RLENGTH) } print line }' "$j" > "$t"`,
    "  if grep -Eq '^[^#]*--maxfiles' \"$t\"; then die \"$j has a maxfiles value that is not a number\"; fi",
    `  awk -v f="$j" 'NR == FNR { a[FNR] = $0; next } $0 != a[FNR] { b = a[FNR]; c = $0; gsub(/\\t/, " ", b); gsub(/\\t/, " ", c); printf "%s\\t%s\\t%s\\n", f, b, c }' "$j" "$t"`,
    '  if [ "$apply" = 1 ]; then save "$j" vzdump.cron; cat "$t" > "$j"; fi',
    'fi',
  ].join('\n');

export const PVE_COMMANDS = {
  /** The checklist, with the expensive checks. Read-only; needs root to read everything. */
  pve8to9: {
    id: 'pve.pve8to9',
    readOnly: true,
    privileged: true,
    timeoutMs: 10 * MINUTE,
    interruptible: true,
    argv: ['pve8to9', '--full'],
  },
  /** The CPU's vendor, as the kernel reports it: what decides the microcode package. */
  cpuVendor: {
    id: 'pve.cpu_vendor',
    readOnly: true,
    privileged: false,
    timeoutMs: MINUTE,
    interruptible: true,
    argv: ['grep', '-m1', '^vendor_id', '/proc/cpuinfo'],
  },
  sysctlRead: {
    id: 'pve.sysctl_read',
    readOnly: true,
    privileged: false,
    timeoutMs: MINUTE,
    interruptible: true,
    argv: ['cat', '/etc/sysctl.conf'],
  },
  /** Every setting out of /etc/sysctl.conf into one file of /etc/sysctl.d/, commented where it was. */
  sysctlMove: {
    id: 'pve.sysctl_move',
    readOnly: false,
    privileged: true,
    timeoutMs: MINUTE,
    interruptible: true,
    argv: [
      'sh',
      '-c',
      `set -e; cp -p /etc/sysctl.conf /etc/sysctl.conf.velnox-before; grep -Ev '^[[:space:]]*([#;]|$)' /etc/sysctl.conf > ${SYSCTL_D}; sed -i -E 's|^([[:space:]]*[^#;[:space:]].*)$|# moved to ${SYSCTL_D}: \\1|' /etc/sysctl.conf; sysctl --system > /dev/null`,
    ],
  },
  removeSystemdBoot: {
    id: 'pve.remove_systemd_boot',
    readOnly: false,
    privileged: true,
    timeoutMs: 10 * MINUTE,
    interruptible: false,
    argv: [...APT, 'remove', 'systemd-boot'],
  },
  installGrubEfi: {
    id: 'pve.install_grub_efi',
    readOnly: false,
    privileged: true,
    timeoutMs: 10 * MINUTE,
    interruptible: false,
    argv: [...APT, 'install', 'grub-efi-amd64'],
  },
  grubRemovable: {
    id: 'pve.grub_removable',
    readOnly: false,
    privileged: true,
    timeoutMs: 10 * MINUTE,
    interruptible: false,
    argv: [
      'sh',
      '-c',
      "echo 'grub-efi-amd64 grub2/force_efi_extra_removable boolean true' | debconf-set-selections -v -u && DEBIAN_FRONTEND=noninteractive apt-get -y install --reinstall grub-efi-amd64",
    ],
  },
  lvmAutoactivation: {
    id: 'pve.lvm_autoactivation',
    readOnly: false,
    privileged: true,
    timeoutMs: 30 * MINUTE,
    interruptible: false,
    argv: ['/usr/share/pve-manager/migrations/pve-lvm-disable-autoactivation'],
  },
  /** What Velnox's own checks read: the audit socket and the linux-image-amd64 question. */
  hostFacts: {
    id: 'pve.host_facts',
    readOnly: true,
    privileged: false,
    timeoutMs: 2 * MINUTE,
    interruptible: true,
    argv: [
      'sh',
      '-c',
      [
        'printf \'audit_socket=%s\\n\' "$(systemctl is-active systemd-journald-audit.socket 2>/dev/null)"',
        `printf 'linux_image=%s\\n' "$(dpkg-query -W -f='${DPKG_STATUS}' linux-image-amd64 2>/dev/null | cut -c1-2)"`,
        'printf \'running_kernel=%s\\n\' "$(uname -r)"',
        `printf 'pve_kernels=%s\\n' "$(dpkg-query -W -f='${DPKG_STATUS} \${Package}\\n' 'proxmox-kernel-*' 'pve-kernel-*' 2>/dev/null | grep -Ec ${PROXMOX_KERNEL})"`,
        "printf 'linux_image_removes=%s\\n' \"$(apt-get -s -o Debug::NoLocking=1 remove linux-image-amd64 2>/dev/null | sed -n 's/^Remv \\([^ ]*\\).*/\\1/p' | tr '\\n' ' ')\"",
      ].join('\n'),
    ],
  },
  /**
   * Proxmox's advice for the upgrade: journald starts logging kernel audit
   * messages during it. Run just before the node's dist-upgrade. On bookworm
   * the unit is static, so `disable` changes nothing there and `--now` is what
   * stops it; Debian 13 has it disabled by default.
   */
  auditSocketStop: {
    id: 'pve.audit_socket_stop',
    readOnly: false,
    privileged: true,
    timeoutMs: MINUTE,
    interruptible: true,
    argv: ['systemctl', 'disable', '--now', 'systemd-journald-audit.socket'],
  },
  timesyncServers: {
    id: 'pve.timesync_servers',
    readOnly: true,
    privileged: false,
    timeoutMs: MINUTE,
    interruptible: true,
    argv: [
      'timedatectl',
      'show-timesync',
      '--property=SystemNTPServers',
      '--property=LinkNTPServers',
      '--value',
    ],
  },
  chrony: {
    id: 'pve.chrony',
    readOnly: false,
    privileged: true,
    timeoutMs: 15 * MINUTE,
    interruptible: false,
    argv: ['sh', '-c', CHRONY_SCRIPT],
  },
  removeLinuxImage: {
    id: 'pve.remove_linux_image',
    readOnly: false,
    privileged: true,
    timeoutMs: 10 * MINUTE,
    interruptible: false,
    argv: ['sh', '-c', REMOVE_LINUX_IMAGE_SCRIPT],
  },
  maxfilesShow: {
    id: 'pve.maxfiles_show',
    readOnly: true,
    privileged: true,
    timeoutMs: MINUTE,
    interruptible: true,
    argv: ['sh', '-c', maxfilesScript(false)],
  },
  maxfilesApply: {
    id: 'pve.maxfiles_apply',
    readOnly: false,
    privileged: true,
    timeoutMs: 5 * MINUTE,
    interruptible: false,
    argv: ['sh', '-c', maxfilesScript(true)],
  },
  aptCacheSize: {
    id: 'pve.apt_cache_size',
    readOnly: true,
    privileged: true,
    timeoutMs: MINUTE,
    interruptible: true,
    argv: ['du', '-sm', '/var/cache/apt/archives'],
  },
  aptClean: {
    id: 'pve.apt_clean',
    readOnly: false,
    privileged: true,
    timeoutMs: 5 * MINUTE,
    interruptible: false,
    argv: ['env', 'LC_ALL=C', 'apt-get', 'clean'],
  },
  /**
   * Every Ceph repository to Squid, each changed file kept as `*.velnox-ceph`.
   *
   * Only Squid is published for trixie: a node still pointing at ceph-quincy
   * or ceph-reef — the default on Proxmox VE 8 even where Ceph was never set
   * up — makes `apt-get update` fail with exit code 100 once its sources move
   * to trixie. Run on a node without Ceph daemons, before the move; a node with
   * them is on Squid already, which the preflight insists on. The channel —
   * enterprise or no-subscription — is left as it is.
   */
  cephSquid: {
    id: 'pve.ceph_squid',
    readOnly: false,
    privileged: true,
    timeoutMs: 5 * MINUTE,
    interruptible: true,
    argv: [
      'sh',
      '-c',
      'set -e; for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do [ -f "$f" ] || continue; grep -E "/debian/ceph-[a-z]+" "$f" | grep -qv "/debian/ceph-squid" || continue; cp -p "$f" "$f.velnox-ceph"; sed -i -E "s#/debian/ceph-[a-z]+#/debian/ceph-squid#g" "$f"; done; for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do [ -f "$f" ] && grep -hE "/debian/ceph-" "$f"; done | grep -v "^ *#" || true',
    ],
  },
  /** Debian and Proxmox sources from bookworm to trixie, each file kept as `*.velnox-bookworm`. */
  sourcesTrixie: {
    id: 'pve.sources_trixie',
    readOnly: false,
    privileged: true,
    timeoutMs: 5 * MINUTE,
    interruptible: true,
    argv: [
      'sh',
      '-c',
      'set -e; for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do [ -f "$f" ] || continue; grep -q bookworm "$f" || continue; cp -p "$f" "$f.velnox-bookworm"; sed -i "s/\\bbookworm\\b/trixie/g" "$f"; done; grep -rh trixie /etc/apt/sources.list /etc/apt/sources.list.d/ 2>/dev/null || true',
    ],
  },
} as const satisfies Record<string, CommandSpec>;

export type MicrocodePackage = 'intel-microcode' | 'amd64-microcode';

/**
 * The vendor in a `/proc/cpuinfo` `vendor_id` line, and the microcode
 * package Debian has for it — the choice pve8to9 makes (`get_cpu_microcode_pkg`),
 * made by Velnox from the node itself. Null for a line it cannot read and for
 * any other vendor: nothing is guessed.
 */
export function microcodeFor(cpuinfo: string): {
  vendor: string | null;
  pkg: MicrocodePackage | null;
} {
  const vendor = /^vendor_id\s*:\s*(\S+)/m.exec(cpuinfo)?.[1] ?? null;
  const pkg =
    vendor === 'GenuineIntel' ? 'intel-microcode' : vendor === 'AuthenticAMD' ? 'amd64-microcode' : null;
  return { vendor, pkg };
}

/**
 * The CPU's microcode, as pve8to9 advises: Debian's `non-free-firmware`
 * component enabled on the Debian sources, then the package for this CPU —
 * one fixed command per vendor.
 */
export function microcodeCommand(pkg: MicrocodePackage): CommandSpec {
  return {
    id: `pve.microcode.${pkg}`,
    readOnly: false,
    privileged: true,
    timeoutMs: 10 * MINUTE,
    interruptible: false,
    argv: [
      'sh',
      '-c',
      `set -e; for f in /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources; do [ -f "$f" ] && cp -p "$f" "$f.velnox-before"; done; [ -f /etc/apt/sources.list ] && sed -i -E '/^deb .*(deb|security)\\.debian\\.org/{/non-free-firmware/!s/$/ non-free-firmware/}' /etc/apt/sources.list; [ -f /etc/apt/sources.list.d/debian.sources ] && sed -i -E '/^Components:/{/non-free-firmware/!s/$/ non-free-firmware/}' /etc/apt/sources.list.d/debian.sources; export DEBIAN_FRONTEND=noninteractive; apt-get update -qq; apt-get install -y ${pkg}`,
    ],
  };
}

/** What `hostFacts` read from a node. */
export interface HostFacts {
  auditSocketActive: boolean;
  linuxImageInstalled: boolean;
  runningKernel: string;
  pveKernels: number;
  linuxImageRemoves: string[];
}

/** `hostFacts`'s lines; null when one is missing, so nothing is concluded from half an answer. */
export function parseHostFacts(output: string): HostFacts | null {
  const read = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at > 0) read.set(line.slice(0, at), line.slice(at + 1).trim());
  }
  const keys = ['audit_socket', 'linux_image', 'running_kernel', 'pve_kernels', 'linux_image_removes'];
  if (!keys.every((k) => read.has(k))) return null;
  const pveKernels = Number(read.get('pve_kernels'));
  if (!read.get('running_kernel') || !Number.isInteger(pveKernels)) return null;
  return {
    auditSocketActive: read.get('audit_socket') === 'active',
    linuxImageInstalled: read.get('linux_image') === 'ii',
    runningKernel: read.get('running_kernel')!,
    pveKernels,
    linuxImageRemoves: read.get('linux_image_removes')!.split(/\s+/).filter(Boolean),
  };
}

/** Why linux-image-amd64 must not be removed from this node, or null when it may. */
export function linuxImageRefusal(facts: HostFacts): string | null {
  if (!facts.runningKernel.endsWith('-pve')) {
    return `the node runs kernel ${facts.runningKernel}, not a Proxmox kernel`;
  }
  if (facts.pveKernels < 1) return 'no Proxmox kernel is installed';
  const others = facts.linuxImageRemoves.filter((p) => p !== 'linux-image-amd64');
  if (others.length) return `removing it would also remove ${others.join(', ')}`;
  if (!facts.linuxImageRemoves.length) return 'apt does not say what removing it would do';
  return null;
}

/** The NTP servers timesyncd reports; null when one is not a plain host name or address. */
export function parseNtpServers(output: string): string[] | null {
  const servers = [...new Set(output.split(/\s+/).filter(Boolean))].sort();
  return servers.every((s) => /^[A-Za-z0-9.:][A-Za-z0-9.:-]*$/.test(s)) ? servers : null;
}

/** The file `chrony` writes for those servers; empty for none. */
export const ntpSourcesFile = (servers: readonly string[]): string =>
  servers.map((s) => `server ${s} iburst prefer`).join('\n');

export interface MaxfilesChange {
  where: string;
  before: string;
  after: string;
}

/** The lines `maxfilesShow` printed. */
export function parseMaxfilesChanges(output: string): MaxfilesChange[] {
  const out: MaxfilesChange[] = [];
  for (const line of output.split(/\r?\n/)) {
    const [where, before, after, ...rest] = line.split('\t');
    if (where && before && after && !rest.length) out.push({ where, before, after });
  }
  return out;
}

/** Those changes as the files of a change set, one entry per place. */
export function maxfilesFiles(changes: readonly MaxfilesChange[]): ChangeSet['files'] {
  const places = [...new Set(changes.map((c) => c.where))];
  return places.map((path) => {
    const here = changes.filter((c) => c.where === path);
    return {
      path,
      before: here.map((c) => c.before).join('\n'),
      after: here.map((c) => c.after).join('\n'),
    };
  });
}

/**
 * A change the node would make now that was not approved, or null. Fewer is
 * fine: a storage is shared, so the first node's run already did it for the rest.
 */
export function maxfilesDrift(
  approved: ChangeSet['files'],
  now: readonly MaxfilesChange[],
): MaxfilesChange | null {
  for (const change of now) {
    const file = approved.find((f) => f.path === change.where);
    const before = (file?.before ?? '').split('\n');
    const after = (file?.after ?? '').split('\n');
    if (!before.includes(change.before) || !after.includes(change.after)) return change;
  }
  return null;
}

/** Proxmox's rule for a node name: what may follow `hostname -s`. */
const NODE_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** POSIX single-quoting: everything literal, a quote ended, escaped and reopened. */
export const shellQuote = (value: string): string =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;

/** The exit code the guard uses when the node is not the one meant. */
export const WRONG_NODE_EXIT = 97;

/** The command string sent for a spec on a node, as an account. */
export function commandLine(spec: CommandSpec, node: string, username: string): string {
  if (!NODE_NAME.test(node)) throw new Error(`Not a node name: ${node.slice(0, 64)}`);
  const guard = `[ "$(hostname -s)" = ${shellQuote(node)} ] || { echo "velnox: this is not ${node}" >&2; exit ${WRONG_NODE_EXIT}; }`;
  const sudo = spec.privileged && username !== 'root' ? 'sudo -n ' : '';
  return `${guard}; ${sudo}${spec.argv.map(shellQuote).join(' ')}`;
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

export interface SimulatedInstall {
  package: string;
  currentVersion: string | null;
  candidateVersion: string;
  /** Where apt would get it, e.g. `Debian-Security:12/stable-security`. */
  archive: string | null;
}

/**
 * `apt-get -s dist-upgrade`'s `Inst` lines:
 *
 *   Inst libssl3 [3.0.13-1~deb12u1] (3.0.14-1~deb12u2 Debian-Security:12/stable-security [amd64])
 *   Inst proxmox-kernel-6.8.12-5-pve-signed (6.8.12-5 Proxmox:bookworm/pve-no-subscription [amd64])
 */
export function parseAptSimulate(output: string): SimulatedInstall[] {
  const out: SimulatedInstall[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^Inst (\S+)(?: \[([^\]]+)\])? \((\S+)(?: ([^[)]+?))?(?: \[[^\]]+\])?\)/.exec(
      line,
    );
    if (!match) continue;
    out.push({
      package: match[1]!,
      currentVersion: match[2] ?? null,
      candidateVersion: match[3]!,
      archive: match[4]?.trim() || null,
    });
  }
  return out;
}

/** The packages `apt-get -s autoremove` says it would remove (its `Remv` lines). */
export function parseAptRemovals(output: string): string[] {
  const out: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^Remv (\S+)/.exec(line);
    if (match) out.push(match[1]!);
  }
  return out;
}

/**
 * Packages an autoremove may never take, whatever apt thinks of them: Proxmox
 * itself and what boots the node. Apt would only offer one of these when
 * something is already wrong — a meta-package removed by hand, a repository
 * gone — and that is a node for a person to look at, not to tidy.
 */
const NEVER_AUTOREMOVED =
  /^(proxmox-ve|pve-manager|pve-cluster|pve-container|qemu-server|pve-qemu-kvm|corosync|proxmox-default-kernel|proxmox-kernel-helper|pve-kernel-helper|proxmox-backup-client|ifupdown2|openssh-server|grub-.+|shim-.+|ceph|ceph-(?:base|common|mon|mgr|osd|mds|fuse))(?::\S+)?$/;

/**
 * Why this removal must not happen, or null when it may. A kernel is kept when
 * it is the one running — taking it leaves no modules for what it loads next
 * — or the newest installed, which the next boot will use.
 */
export function autoremoveRefusal(
  removals: readonly string[],
  keepKernels: readonly string[],
): string | null {
  const keep = new Set(keepKernels.map((k) => k.replace(/-pve$/, '')));
  for (const name of removals) {
    if (NEVER_AUTOREMOVED.test(name)) return `it would remove ${name}`;
    const kernel = /^(?:proxmox|pve)-kernel-(\d+\.\d+\.\d+-\d+)/.exec(name);
    if (kernel && keep.has(kernel[1]!)) {
      return `it would remove ${name}, a kernel that is running or newest`;
    }
  }
  return null;
}

/** `system.reboot_required`'s answer: whether, and which packages asked. */
export function parseRebootRequired(output: string): { required: boolean; packages: string[] } {
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return { required: lines[0] === 'required', packages: lines.slice(1) };
}

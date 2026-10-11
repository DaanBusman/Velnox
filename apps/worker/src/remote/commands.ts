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

/** `system.reboot_required`'s answer: whether, and which packages asked. */
export function parseRebootRequired(output: string): { required: boolean; packages: string[] } {
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return { required: lines[0] === 'required', packages: lines.slice(1) };
}

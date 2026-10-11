import { describe, expect, it } from 'vitest';
import {
  COMMANDS,
  WRONG_NODE_EXIT,
  commandLine,
  parseAptSimulate,
  parseRebootRequired,
  shellQuote,
} from './commands';

describe('commandLine', () => {
  it('guards every command with the node name, and runs a fixed argv', () => {
    expect(commandLine(COMMANDS.aptSimulate, 'pve1', 'root')).toBe(
      `[ "$(hostname -s)" = pve1 ] || { echo "velnox: this is not pve1" >&2; exit ${WRONG_NODE_EXIT}; }; env LC_ALL=C apt-get -s -o Debug::NoLocking=1 dist-upgrade`,
    );
  });

  it('adds sudo -n for a privileged command when the account is not root, and only then', () => {
    expect(commandLine(COMMANDS.aptDistUpgrade, 'pve1', 'velnox')).toContain(
      '; sudo -n env LC_ALL=C DEBIAN_FRONTEND=noninteractive apt-get -y',
    );
    expect(commandLine(COMMANDS.aptDistUpgrade, 'pve1', 'root')).not.toContain('sudo');
    expect(commandLine(COMMANDS.aptSimulate, 'pve1', 'velnox')).not.toContain('sudo');
  });

  it('refuses a node name that is not one, so nothing from outside reaches the shell', () => {
    expect(() => commandLine(COMMANDS.aptSimulate, 'pve1; rm -rf /', 'root')).toThrow(
      /Not a node name/,
    );
    expect(() => commandLine(COMMANDS.aptSimulate, '$(id)', 'root')).toThrow(/Not a node name/);
  });

  it('quotes what the shell would read', () => {
    expect(shellQuote('Dpkg::Options::=--force-confold')).toBe('Dpkg::Options::=--force-confold');
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote('a b')).toBe("'a b'");
  });

  it('marks the dist-upgrade as not interruptible, and the reads as read-only', () => {
    expect(COMMANDS.aptDistUpgrade.interruptible).toBe(false);
    expect(COMMANDS.aptDistUpgrade.readOnly).toBe(false);
    expect(COMMANDS.aptSimulate.readOnly).toBe(true);
    expect(COMMANDS.rebootRequired.readOnly).toBe(true);
  });
});

describe('parsers', () => {
  it('reads apt-get -s output, with and without a current version', () => {
    const output = [
      'NOTE: This is only a simulation!',
      'Inst libssl3 [3.0.13-1~deb12u1] (3.0.14-1~deb12u2 Debian-Security:12/stable-security [amd64])',
      'Inst proxmox-kernel-6.8.12-5-pve-signed (6.8.12-5 Proxmox:bookworm/pve-no-subscription [amd64])',
      'Conf libssl3 (3.0.14-1~deb12u2 Debian-Security:12/stable-security [amd64])',
    ].join('\n');
    expect(parseAptSimulate(output)).toEqual([
      {
        package: 'libssl3',
        currentVersion: '3.0.13-1~deb12u1',
        candidateVersion: '3.0.14-1~deb12u2',
        archive: 'Debian-Security:12/stable-security',
      },
      {
        package: 'proxmox-kernel-6.8.12-5-pve-signed',
        currentVersion: null,
        candidateVersion: '6.8.12-5',
        archive: 'Proxmox:bookworm/pve-no-subscription',
      },
    ]);
  });

  it('reads whether the node asks for a reboot', () => {
    expect(parseRebootRequired('required\nlinux-base\n')).toEqual({
      required: true,
      packages: ['linux-base'],
    });
    expect(parseRebootRequired('no\n')).toEqual({ required: false, packages: [] });
  });
});

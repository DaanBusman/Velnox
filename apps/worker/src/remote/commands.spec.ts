import { describe, expect, it } from 'vitest';
import {
  COMMANDS,
  WRONG_NODE_EXIT,
  autoremoveRefusal,
  commandLine,
  parseAptRemovals,
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

describe('apt-get autoremove', () => {
  it('runs privileged and uninterrupted, after a read-only simulation', () => {
    expect(COMMANDS.aptAutoremoveSimulate.readOnly).toBe(true);
    expect(COMMANDS.aptAutoremoveSimulate.privileged).toBe(false);
    expect(COMMANDS.aptAutoremove.privileged).toBe(true);
    expect(COMMANDS.aptAutoremove.interruptible).toBe(false);
    expect(COMMANDS.aptAutoremove.argv).not.toContain('--purge');
  });

  it('reads what it would remove from the Remv lines only', () => {
    const output = [
      'NOTE: This is only a simulation!',
      'The following packages will be REMOVED:',
      '  libllvm15 proxmox-kernel-6.8.12-4-pve-signed',
      'Remv libllvm15 [1:15.0.6-4+b1]',
      'Remv proxmox-kernel-6.8.12-4-pve-signed [6.8.12-4]',
    ].join('\n');
    expect(parseAptRemovals(output)).toEqual(['libllvm15', 'proxmox-kernel-6.8.12-4-pve-signed']);
    expect(parseAptRemovals('0 upgraded, 0 newly installed, 0 to remove')).toEqual([]);
  });

  const keep = ['6.8.12-5-pve', '6.8.12-6'];

  it('allows an old kernel and a library', () => {
    expect(autoremoveRefusal(['libllvm15', 'proxmox-kernel-6.8.12-4-pve-signed'], keep)).toBeNull();
  });

  it('refuses the running kernel, under either package family', () => {
    expect(autoremoveRefusal(['proxmox-kernel-6.8.12-5-pve-signed'], keep)).toMatch(/kernel/);
    expect(autoremoveRefusal(['pve-kernel-6.8.12-5-pve'], keep)).toMatch(/kernel/);
  });

  it('refuses the newest kernel, which the next boot will use', () => {
    expect(autoremoveRefusal(['proxmox-kernel-6.8.12-6-pve-signed'], keep)).toMatch(/kernel/);
  });

  it('does not mistake one kernel for another that starts the same', () => {
    expect(autoremoveRefusal(['proxmox-kernel-6.8.12-50-pve-signed'], keep)).toBeNull();
  });

  it.each([
    'proxmox-ve',
    'pve-manager',
    'corosync',
    'grub-efi-amd64',
    'ceph-osd',
    'qemu-server:amd64',
  ])('refuses %s', (name) => {
    expect(autoremoveRefusal([name], keep)).toContain(name);
  });
});

import { describe, expect, it } from 'vitest';
import { PVE_COMMANDS, commandLine, microcodeCommand } from './commands';

describe('Proxmox VE 8 → 9 commands', () => {
  it('runs pve8to9 with the expensive checks, as root through sudo when not root', () => {
    expect(commandLine(PVE_COMMANDS.pve8to9, 'pve1', 'velnox')).toMatch(
      /; sudo -n pve8to9 --full$/,
    );
    expect(commandLine(PVE_COMMANDS.pve8to9, 'pve1', 'root')).toMatch(/; pve8to9 --full$/);
  });

  it('enables non-free-firmware on Debian’s sources only, keeps them, then installs the package', () => {
    const script = microcodeCommand('intel-microcode').argv[2]!;
    expect(script).toContain('cp -p "$f" "$f.velnox-before"');
    expect(script).toContain(
      "sed -i -E '/^deb .*(deb|security)\\.debian\\.org/{/non-free-firmware/!s/$/ non-free-firmware/}' /etc/apt/sources.list",
    );
    expect(script).toContain(
      "sed -i -E '/^Components:/{/non-free-firmware/!s/$/ non-free-firmware/}'",
    );
    expect(script).toMatch(/apt-get install -y intel-microcode$/);
    expect(microcodeCommand('amd64-microcode').id).toBe('pve.microcode.amd64-microcode');
  });

  it('moves sysctl settings with a backreference the shell receives intact', () => {
    const script = PVE_COMMANDS.sysctlMove.argv[2];
    expect(script).toContain('cp -p /etc/sysctl.conf /etc/sysctl.conf.velnox-before');
    expect(script).toContain(
      's|^([[:space:]]*[^#;[:space:]].*)$|# moved to /etc/sysctl.d/99-velnox-from-sysctl-conf.conf: \\1|',
    );
  });

  it('moves the sources to trixie word by word, keeping each file', () => {
    const script = PVE_COMMANDS.sourcesTrixie.argv[2];
    expect(script).toContain('sed -i "s/\\bbookworm\\b/trixie/g" "$f"');
    expect(script).toContain('cp -p "$f" "$f.velnox-bookworm"');
  });

  it('never lets a cancel interrupt apt', () => {
    for (const spec of [
      PVE_COMMANDS.removeSystemdBoot,
      PVE_COMMANDS.installGrubEfi,
      microcodeCommand('intel-microcode'),
    ]) {
      expect(spec.interruptible).toBe(false);
    }
  });
});

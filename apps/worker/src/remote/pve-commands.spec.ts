import { describe, expect, it } from 'vitest';
import {
  PVE_COMMANDS,
  commandLine,
  linuxImageRefusal,
  maxfilesDrift,
  maxfilesFiles,
  microcodeCommand,
  microcodeFor,
  ntpSourcesFile,
  parseHostFacts,
  parseMaxfilesChanges,
  parseNtpServers,
  type HostFacts,
} from './commands';

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

  it('reads the CPU vendor from the node, and takes the package from it', () => {
    expect(commandLine(PVE_COMMANDS.cpuVendor, 'pve1', 'velnox')).toMatch(
      /grep -m1 '\^vendor_id' \/proc\/cpuinfo$/,
    );
    expect(microcodeFor('vendor_id\t: AuthenticAMD\n')).toEqual({
      vendor: 'AuthenticAMD',
      pkg: 'amd64-microcode',
    });
    expect(microcodeFor('vendor_id\t: GenuineIntel\n')).toEqual({
      vendor: 'GenuineIntel',
      pkg: 'intel-microcode',
    });
  });

  it('guesses nothing for another vendor or an unreadable line', () => {
    expect(microcodeFor('vendor_id\t: HygonGenuine\n')).toEqual({
      vendor: 'HygonGenuine',
      pkg: null,
    });
    expect(microcodeFor('')).toEqual({ vendor: null, pkg: null });
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

  it('moves every Ceph repository to Squid, keeping each file it changes', () => {
    const script = PVE_COMMANDS.cephSquid.argv[2];
    expect(script).toContain('sed -i -E "s#/debian/ceph-[a-z]+#/debian/ceph-squid#g" "$f"');
    expect(script).toContain('cp -p "$f" "$f.velnox-ceph"');
    // A file already on Squid is not touched, so its backup is never overwritten.
    expect(script).toContain('grep -qv "/debian/ceph-squid" || continue');
  });

  describe('what pve8to9 does not check', () => {
    const facts: HostFacts = {
      auditSocketActive: true,
      linuxImageInstalled: true,
      runningKernel: '6.8.12-4-pve',
      pveKernels: 1,
      linuxImageRemoves: ['linux-image-amd64'],
    };

    it('reads the host facts whole, or not at all', () => {
      expect(
        parseHostFacts(
          'audit_socket=active\nlinux_image=ii\nrunning_kernel=6.8.12-4-pve\npve_kernels=1\nlinux_image_removes=linux-image-amd64 \n',
        ),
      ).toEqual(facts);
      expect(parseHostFacts('audit_socket=active\n')).toBeNull();
      expect(
        parseHostFacts(
          'audit_socket=inactive\nlinux_image=rc\nrunning_kernel=6.8.12-4-pve\npve_kernels=1\nlinux_image_removes=\n',
        ),
      ).toMatchObject({ auditSocketActive: false, linuxImageInstalled: false });
    });

    it('removes linux-image-amd64 only from a node on a Proxmox kernel, and only that', () => {
      expect(linuxImageRefusal(facts)).toBeNull();
      expect(linuxImageRefusal({ ...facts, runningKernel: '6.1.0-30-amd64' })).toMatch(
        /not a Proxmox kernel/,
      );
      expect(linuxImageRefusal({ ...facts, pveKernels: 0 })).toMatch(/no Proxmox kernel/);
      expect(
        linuxImageRefusal({ ...facts, linuxImageRemoves: ['linux-image-amd64', 'other'] }),
      ).toMatch(/also remove other/);
      expect(linuxImageRefusal({ ...facts, linuxImageRemoves: [] })).toMatch(/does not say/);
    });

    it('stops the audit socket with the command Proxmox gives', () => {
      expect(PVE_COMMANDS.auditSocketStop.argv.join(' ')).toBe(
        'systemctl disable --now systemd-journald-audit.socket',
      );
    });

    it('keeps the NTP servers, refusing one that is not a name or address', () => {
      expect(parseNtpServers('ntp1.lan 10.0.0.5\nntp1.lan\n')).toEqual(['10.0.0.5', 'ntp1.lan']);
      expect(parseNtpServers('fd00::123\n')).toEqual(['fd00::123']);
      expect(parseNtpServers('\n')).toEqual([]);
      expect(parseNtpServers('-o evil\n')).toBeNull();
      expect(parseNtpServers('a;reboot\n')).toBeNull();
      expect(ntpSourcesFile(['10.0.0.5'])).toBe('server 10.0.0.5 iburst prefer');
      expect(ntpSourcesFile([])).toBe('');
    });

    it('leaves chrony.conf as the package shipped it', () => {
      expect(PVE_COMMANDS.chrony.argv[2]).not.toContain('/etc/chrony/chrony.conf');
    });

    it('shows and applies retention with the same script', () => {
      const show = PVE_COMMANDS.maxfilesShow.argv[2];
      const apply = PVE_COMMANDS.maxfilesApply.argv[2];
      expect(show.replace('apply=0', 'apply=1')).toBe(apply);
      expect(PVE_COMMANDS.maxfilesShow.readOnly).toBe(true);
    });

    it('reads retention changes and groups them by place', () => {
      const changes = parseMaxfilesChanges(
        '/etc/vzdump.conf\tmaxfiles: 3\tprune-backups: keep-last=3\n/etc/pve/vzdump.cron\ta --maxfiles 1\ta --prune-backups keep-last=1\n/etc/pve/vzdump.cron\tb --maxfiles 0\tb --prune-backups keep-all=1\nnoise\n',
      );
      expect(changes).toHaveLength(3);
      expect(maxfilesFiles(changes)).toEqual([
        { path: '/etc/vzdump.conf', before: 'maxfiles: 3', after: 'prune-backups: keep-last=3' },
        {
          path: '/etc/pve/vzdump.cron',
          before: 'a --maxfiles 1\nb --maxfiles 0',
          after: 'a --prune-backups keep-last=1\nb --prune-backups keep-all=1',
        },
      ]);
    });

    it('allows fewer changes than approved, never another', () => {
      const approved = maxfilesFiles([
        { where: 'storage nas', before: 'maxfiles 5', after: 'prune-backups keep-last=5' },
        { where: '/etc/vzdump.conf', before: 'maxfiles: 3', after: 'prune-backups: keep-last=3' },
      ]);
      // The storage is shared: the first node's run already did it.
      expect(
        maxfilesDrift(approved, [
          { where: '/etc/vzdump.conf', before: 'maxfiles: 3', after: 'prune-backups: keep-last=3' },
        ]),
      ).toBeNull();
      expect(
        maxfilesDrift(approved, [
          { where: 'storage nas', before: 'maxfiles 9', after: 'prune-backups keep-last=9' },
        ]),
      ).toMatchObject({ where: 'storage nas' });
      expect(
        maxfilesDrift(approved, [
          { where: 'storage other', before: 'maxfiles 5', after: 'prune-backups keep-last=5' },
        ]),
      ).toMatchObject({ where: 'storage other' });
    });
  });

  it('never lets a cancel interrupt apt', () => {
    for (const spec of [
      PVE_COMMANDS.chrony,
      PVE_COMMANDS.removeLinuxImage,
      PVE_COMMANDS.aptClean,
      PVE_COMMANDS.removeSystemdBoot,
      PVE_COMMANDS.installGrubEfi,
      microcodeCommand('intel-microcode'),
    ]) {
      expect(spec.interruptible).toBe(false);
    }
  });
});

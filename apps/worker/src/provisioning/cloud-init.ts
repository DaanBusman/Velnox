import { RECOMMENDED_MIRRORS, type LinuxTemplate, type ProvisionNetwork } from '@velnox/shared';
import { sha512Crypt } from './sha512-crypt';

/**
 * A Linux template turned into cloud-init's NoCloud seed.
 *
 * Three files, which go onto a small ISO labelled `cidata` attached to the VM:
 * `user-data`, `meta-data` and `network-config`. See iso9660.ts for why an ISO
 * rather than Proxmox's own cloud-init drive.
 *
 * `user-data` is written as JSON under the `#cloud-config` header. YAML is a
 * superset of JSON, cloud-init parses it with a YAML parser, and generating
 * JSON means no hand-rolled YAML quoting — the place a password or a key
 * comment containing a colon would otherwise go wrong.
 *
 * **No plaintext password reaches the guest.** Every password is hashed here
 * with SHA-512-crypt; cloud-init writes the hash to /etc/shadow, which is what
 * it would have computed anyway.
 */

/** Written last by cloud-init; Velnox reads it through the guest agent to know the VM is done. */
export const LINUX_DONE_MARKER = '/var/lib/velnox/provisioned';

export interface CloudInitInput {
  settings: LinuxTemplate;
  hostname: string;
  /** Stable per provisioning, so a re-run of cloud-init on the same VM is not a new instance. */
  instanceId: string;
  /** The MAC Proxmox gave the VM's first NIC; the network config matches on it. */
  macAddress: string;
  network: ProvisionNetwork;
  /** Plaintext passwords decided for this VM, by account name; `root` for root. Hashed here. */
  passwords: Record<string, string>;
}

export interface CloudInitSeed {
  userData: string;
  metaData: string;
  networkConfig: string;
}

export function buildCloudInit(input: CloudInitInput): CloudInitSeed {
  const { settings, passwords } = input;
  const hash = (name: string): string | null => {
    const plain = passwords[name];
    return plain === undefined ? null : sha512Crypt(plain);
  };

  const users: Record<string, unknown>[] = settings.users.map((user) => {
    const hashed = user.password === 'NONE' ? null : hash(user.name);
    if (user.password !== 'NONE' && !hashed) {
      throw new Error(`No password was decided for ${user.name}`);
    }
    return {
      name: user.name,
      shell: '/bin/bash',
      groups: user.sudo ? ['sudo'] : [],
      // A key-only account cannot type a password for sudo, so it gets it
      // without one; an account with a password is asked for it.
      ...(user.sudo ? { sudo: hashed ? 'ALL=(ALL) ALL' : 'ALL=(ALL) NOPASSWD:ALL' } : {}),
      lock_passwd: hashed === null,
      ...(hashed ? { passwd: hashed } : {}),
      ...(settings.ssh.enabled && user.sshKeys.length > 0
        ? { ssh_authorized_keys: user.sshKeys }
        : {}),
    };
  });

  const rootHash = settings.root.password === 'NONE' ? null : hash('root');
  if (settings.root.password !== 'NONE' && !rootHash) {
    throw new Error('No password was decided for root');
  }

  const packages = new Set<string>(settings.packages);
  if (settings.guestAgent) packages.add('qemu-guest-agent');
  if (settings.ssh.enabled) packages.add('openssh-server');
  if (settings.unattendedUpgrades) packages.add('unattended-upgrades');

  const sshdDropIn = [
    '# Written by Velnox at provisioning.',
    `PasswordAuthentication ${settings.ssh.passwordAuthentication ? 'yes' : 'no'}`,
    `KbdInteractiveAuthentication ${settings.ssh.passwordAuthentication ? 'yes' : 'no'}`,
    // Root with a key when root login is allowed; never root with a password
    // unless password authentication is on as well.
    `PermitRootLogin ${
      !settings.root.allowLogin
        ? 'no'
        : settings.ssh.passwordAuthentication && rootHash
          ? 'yes'
          : 'prohibit-password'
    }`,
    '',
  ].join('\n');

  const writeFiles: Record<string, unknown>[] = [];
  if (settings.ssh.enabled) {
    writeFiles.push({
      path: '/etc/ssh/sshd_config.d/60-velnox.conf',
      permissions: '0644',
      content: sshdDropIn,
    });
  }
  if (settings.unattendedUpgrades) {
    writeFiles.push({
      path: '/etc/apt/apt.conf.d/20auto-upgrades',
      permissions: '0644',
      content: 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n',
    });
  }

  const runcmd: string[][] = [];
  if (settings.ssh.enabled) {
    runcmd.push(['systemctl', 'enable', '--now', 'ssh']);
    runcmd.push(['systemctl', 'reload-or-restart', 'ssh']);
    // Where the image ships a firewall, open SSH in it; where it does not, do nothing.
    runcmd.push(['sh', '-c', 'if command -v ufw >/dev/null && ufw status | grep -q active; then ufw allow OpenSSH; fi']);
  } else {
    runcmd.push(['sh', '-c', 'systemctl disable --now ssh 2>/dev/null || true']);
  }
  if (settings.guestAgent) runcmd.push(['systemctl', 'enable', '--now', 'qemu-guest-agent']);
  // Last, so that the marker means everything above has run.
  runcmd.push(['sh', '-c', `mkdir -p ${LINUX_DONE_MARKER.replace(/\/[^/]+$/, '')} && date -u +%FT%TZ > ${LINUX_DONE_MARKER}`]);

  const config: Record<string, unknown> = {
    hostname: input.hostname,
    preserve_hostname: false,
    manage_etc_hosts: true,
    locale: settings.locale,
    timezone: settings.timeZone,
    keyboard: {
      layout: settings.keyboard.layout,
      ...(settings.keyboard.variant ? { variant: settings.keyboard.variant } : {}),
    },
    users,
    disable_root: !settings.root.allowLogin,
    ssh_pwauth: settings.ssh.enabled && settings.ssh.passwordAuthentication,
    apt: {
      primary: [
        { arches: ['default'], uri: settings.mirror ?? RECOMMENDED_MIRRORS[settings.distribution] },
      ],
      ...(settings.aptProxy ? { proxy: settings.aptProxy } : {}),
    },
    package_update: true,
    package_upgrade: false,
    packages: [...packages].sort(),
    write_files: writeFiles,
    runcmd,
  };
  if (rootHash) {
    config.chpasswd = { expire: false, users: [{ name: 'root', password: rootHash, type: 'hash' }] };
  }
  if (settings.swapMb > 0) {
    const bytes = settings.swapMb * 1024 * 1024;
    config.swap = { filename: '/swapfile', size: bytes, maxsize: bytes };
  }

  const network =
    input.network.mode === 'DHCP'
      ? { dhcp4: true }
      : {
          dhcp4: false,
          addresses: [input.network.address],
          routes: [{ to: 'default', via: input.network.gateway }],
          nameservers: { addresses: input.network.dns },
        };

  return {
    userData: `#cloud-config\n${JSON.stringify(config, null, 2)}\n`,
    metaData: `${JSON.stringify({ 'instance-id': input.instanceId, 'local-hostname': input.hostname }, null, 2)}\n`,
    networkConfig: `${JSON.stringify(
      {
        version: 2,
        ethernets: {
          primary: {
            match: { macaddress: input.macAddress.toLowerCase() },
            ...network,
          },
        },
      },
      null,
      2,
    )}\n`,
  };
}

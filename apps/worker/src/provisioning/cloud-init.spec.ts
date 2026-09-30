import { linuxTemplateSchema } from '@velnox/shared';
import { describe, expect, it } from 'vitest';
import { buildCloudInit, LINUX_DONE_MARKER } from './cloud-init';

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHV2ZWxub3gtdGVzdC1rZXktbm90LXJlYWwtYXQtYWxs ops@msp';

const template = (overrides: Record<string, unknown> = {}) =>
  linuxTemplateSchema.parse({
    family: 'LINUX',
    distribution: 'UBUNTU',
    imageFilename: 'noble-server-cloudimg-amd64.img',
    users: [{ name: 'ops', sshKeys: [KEY] }],
    ...overrides,
  });

const parse = (userData: string) => {
  expect(userData.startsWith('#cloud-config\n')).toBe(true);
  return JSON.parse(userData.slice('#cloud-config\n'.length)) as Record<string, any>;
};

const base = {
  hostname: 'web01',
  instanceId: 'velnox-0b7c',
  macAddress: 'BC:24:11:AA:BB:CC',
  network: { mode: 'DHCP' as const },
  passwords: {},
};

describe('buildCloudInit', () => {
  it('makes the default a sudo user with a key, and nothing else', () => {
    const config = parse(buildCloudInit({ ...base, settings: template() }).userData);
    expect(config.users).toEqual([
      {
        name: 'ops',
        shell: '/bin/bash',
        groups: ['sudo'],
        sudo: 'ALL=(ALL) NOPASSWD:ALL',
        lock_passwd: true,
        ssh_authorized_keys: [KEY],
      },
    ]);
    expect(config.disable_root).toBe(true);
    expect(config.ssh_pwauth).toBe(false);
    expect(config.chpasswd).toBeUndefined();
  });

  it('never puts a plaintext password in the seed', () => {
    const seed = buildCloudInit({
      ...base,
      settings: template({
        users: [{ name: 'ops', sshKeys: [KEY], password: 'GENERATE' }],
        root: { allowLogin: true, password: 'FIXED' },
      }),
      passwords: { ops: 'Correct-Horse-9', root: 'Root-Secret-42' },
    });
    const all = seed.userData + seed.metaData + seed.networkConfig;
    expect(all).not.toContain('Correct-Horse-9');
    expect(all).not.toContain('Root-Secret-42');
    const config = parse(seed.userData);
    expect(config.users[0].passwd).toMatch(/^\$6\$/);
    expect(config.users[0].lock_passwd).toBe(false);
    // With a password, sudo asks for it.
    expect(config.users[0].sudo).toBe('ALL=(ALL) ALL');
    expect(config.chpasswd.users[0]).toMatchObject({ name: 'root', type: 'hash' });
    expect(config.chpasswd.users[0].password).toMatch(/^\$6\$/);
  });

  it('refuses to build when a password the settings call for was not decided', () => {
    expect(() =>
      buildCloudInit({
        ...base,
        settings: template({ users: [{ name: 'ops', sshKeys: [KEY], password: 'GENERATE' }] }),
      }),
    ).toThrow(/ops/);
  });

  it('turns the SSH switch into a drop-in: keys only, root refused, by default', () => {
    const config = parse(buildCloudInit({ ...base, settings: template() }).userData);
    const dropIn = config.write_files.find((f: any) => f.path === '/etc/ssh/sshd_config.d/60-velnox.conf');
    expect(dropIn.content).toContain('PasswordAuthentication no');
    expect(dropIn.content).toContain('PermitRootLogin no');
    expect(config.packages).toContain('openssh-server');
    expect(config.runcmd).toContainEqual(['systemctl', 'enable', '--now', 'ssh']);
  });

  it('lets root in with a key only, unless password logins are on as well', () => {
    const keyOnly = parse(
      buildCloudInit({ ...base, settings: template({ root: { allowLogin: true } }) }).userData,
    );
    expect(keyOnly.write_files[0].content).toContain('PermitRootLogin prohibit-password');
    expect(keyOnly.disable_root).toBe(false);
  });

  it('turns SSH off when the switch is off, and places no keys', () => {
    const config = parse(
      buildCloudInit({
        ...base,
        settings: template({
          ssh: { enabled: false },
          users: [{ name: 'ops', sshKeys: [KEY], password: 'GENERATE' }],
        }),
        passwords: { ops: 'x' },
      }).userData,
    );
    expect(config.users[0].ssh_authorized_keys).toBeUndefined();
    expect(config.packages).not.toContain('openssh-server');
    expect(config.write_files.some((f: any) => f.path.includes('sshd'))).toBe(false);
  });

  it('uses the recommended mirror unless one is chosen', () => {
    const ubuntu = parse(buildCloudInit({ ...base, settings: template() }).userData);
    expect(ubuntu.apt.primary[0].uri).toBe('mirror://mirrors.ubuntu.com/mirrors.txt');
    const debian = parse(
      buildCloudInit({
        ...base,
        settings: template({ distribution: 'DEBIAN', imageFilename: 'debian-12-genericcloud-amd64.qcow2' }),
      }).userData,
    );
    expect(debian.apt.primary[0].uri).toBe('http://deb.debian.org/debian');
    const fixed = parse(
      buildCloudInit({
        ...base,
        settings: template({ mirror: 'http://nl.archive.ubuntu.com/ubuntu', aptProxy: 'http://proxy:3142' }),
      }).userData,
    );
    expect(fixed.apt.primary[0].uri).toBe('http://nl.archive.ubuntu.com/ubuntu');
    expect(fixed.apt.proxy).toBe('http://proxy:3142');
  });

  it('keeps locale, keyboard and time zone as separate settings', () => {
    const config = parse(
      buildCloudInit({
        ...base,
        settings: template({ locale: 'nl_NL.UTF-8', keyboard: { layout: 'us', variant: 'intl' }, timeZone: 'Europe/Amsterdam' }),
      }).userData,
    );
    expect(config.locale).toBe('nl_NL.UTF-8');
    expect(config.keyboard).toEqual({ layout: 'us', variant: 'intl' });
    expect(config.timezone).toBe('Europe/Amsterdam');
  });

  it('installs the guest agent and writes the done marker last', () => {
    const config = parse(buildCloudInit({ ...base, settings: template() }).userData);
    expect(config.packages).toContain('qemu-guest-agent');
    const last = config.runcmd[config.runcmd.length - 1];
    expect(last.join(' ')).toContain(LINUX_DONE_MARKER);
  });

  it('matches the network config on the MAC Proxmox gave the NIC', () => {
    const dhcp = JSON.parse(buildCloudInit({ ...base, settings: template() }).networkConfig);
    expect(dhcp.ethernets.primary.match.macaddress).toBe('bc:24:11:aa:bb:cc');
    expect(dhcp.ethernets.primary.dhcp4).toBe(true);
    const fixed = JSON.parse(
      buildCloudInit({
        ...base,
        settings: template(),
        network: { mode: 'STATIC', address: '192.0.2.10/24', gateway: '192.0.2.1', dns: ['192.0.2.53'] },
      }).networkConfig,
    );
    expect(fixed.ethernets.primary).toMatchObject({
      dhcp4: false,
      addresses: ['192.0.2.10/24'],
      routes: [{ to: 'default', via: '192.0.2.1' }],
      nameservers: { addresses: ['192.0.2.53'] },
    });
  });

  it('adds a swap file only when asked', () => {
    expect(parse(buildCloudInit({ ...base, settings: template() }).userData).swap).toBeUndefined();
    const config = parse(buildCloudInit({ ...base, settings: template({ swapMb: 2048 }) }).userData);
    expect(config.swap).toEqual({ filename: '/swapfile', size: 2147483648, maxsize: 2147483648 });
  });

  it('writes meta-data with the instance id and hostname', () => {
    expect(JSON.parse(buildCloudInit({ ...base, settings: template() }).metaData)).toEqual({
      'instance-id': 'velnox-0b7c',
      'local-hostname': 'web01',
    });
  });
});

describe('linuxTemplateSchema', () => {
  it('refuses a template nobody could log in to', () => {
    expect(() =>
      linuxTemplateSchema.parse({
        family: 'LINUX',
        distribution: 'DEBIAN',
        imageFilename: 'x.qcow2',
        users: [{ name: 'ops' }],
      }),
    ).toThrow(/SSH key or a password/);
  });

  it('refuses root as an extra account', () => {
    expect(() => template({ users: [{ name: 'root', sshKeys: [KEY] }] })).toThrow(/taken/);
  });

  it('refuses something that is not an OpenSSH public key', () => {
    expect(() => template({ users: [{ name: 'ops', sshKeys: ['-----BEGIN OPENSSH PRIVATE KEY-----'] }] })).toThrow();
  });
});

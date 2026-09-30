import { linuxTemplateSchema, windowsTemplateSchema } from '@velnox/shared';
import { describe, expect, it } from 'vitest';
import { macFromNet0, usableAddresses, vmCreateParams, windowsOsType } from './playbook';

const provisioning = {
  id: '0b7c7c5e-0000-4000-8000-000000000001',
  hostname: 'ws-001',
  diskStorage: 'local-lvm',
  mediaStorage: 'local',
  bridge: 'vmbr0',
  vlan: null,
  templateName: 'Windows 11 Pro',
};

const windows = (overrides: Record<string, unknown> = {}) =>
  windowsTemplateSchema.parse({
    family: 'WINDOWS',
    isoFilename: 'Win11_25H2_Dutch_x64.iso',
    imageName: 'Windows 11 Pro',
    virtioIsoFilename: 'virtio-win.iso',
    accounts: [{ name: 'beheer', administrator: true }],
    ...overrides,
  });

describe('vmCreateParams', () => {
  it('builds a Windows 11 VM with UEFI, Secure Boot keys, a TPM and VirtIO', () => {
    const params = vmCreateParams({ vmid: 150, settings: windows(), provisioning });
    expect(params).toMatchObject({
      vmid: 150,
      name: 'ws-001',
      ostype: 'win11',
      machine: 'q35',
      bios: 'ovmf',
      efidisk0: 'local-lvm:1,efitype=4m,pre-enrolled-keys=1',
      tpmstate0: 'local-lvm:1,version=v2.0',
      scsihw: 'virtio-scsi-single',
      scsi0: 'local-lvm:64,iothread=1,discard=on',
      net0: 'virtio,bridge=vmbr0',
      ide2: 'local:iso/Win11_25H2_Dutch_x64.iso,media=cdrom',
      ide0: 'local:iso/virtio-win.iso,media=cdrom',
      boot: 'order=ide2;scsi0',
      agent: 'enabled=1',
      tags: 'velnox',
    });
  });

  it('uses SATA and e1000 without VirtIO, and BIOS for MBR', () => {
    const params = vmCreateParams({
      vmid: 151,
      settings: windows({
        imageName: 'Windows Server 2019 SERVERSTANDARD',
        virtio: false,
        guestAgent: false,
        virtioIsoFilename: null,
        diskLayout: 'MBR',
        accounts: [],
      }),
      provisioning: { ...provisioning, vlan: 20 },
    });
    expect(params).toMatchObject({
      ostype: 'win10',
      bios: 'seabios',
      sata0: 'local-lvm:64,discard=on',
      net0: 'e1000,bridge=vmbr0,tag=20',
      boot: 'order=ide2;sata0',
      agent: 'enabled=0',
    });
    expect(params).not.toHaveProperty('efidisk0');
    expect(params).not.toHaveProperty('ide0');
  });

  it('imports a Linux cloud image as the boot disk, with a serial console', () => {
    const settings = linuxTemplateSchema.parse({
      family: 'LINUX',
      distribution: 'UBUNTU',
      imageFilename: 'noble-server-cloudimg-amd64.img',
      users: [{ name: 'ops', sshKeys: ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHV2ZWxub3g ops'] }],
    });
    const params = vmCreateParams({
      vmid: 152,
      settings,
      provisioning: { ...provisioning, hostname: 'web01' },
      importName: 'noble-server-cloudimg-amd64.qcow2',
    });
    expect(params).toMatchObject({
      ostype: 'l26',
      scsi0:
        'local-lvm:0,import-from=local:import/noble-server-cloudimg-amd64.qcow2,iothread=1,discard=on',
      serial0: 'socket',
      vga: 'serial0',
      boot: 'order=scsi0',
      memory: 2048,
    });
  });

  it('knows which Windows is which to Proxmox', () => {
    expect(windowsOsType('Windows Server 2025 Datacenter')).toBe('win11');
    expect(windowsOsType('Windows Server 2022 SERVERSTANDARD')).toBe('win11');
    expect(windowsOsType('Windows 10 Pro')).toBe('win10');
  });
});

describe('macFromNet0', () => {
  it('reads the MAC Proxmox generated', () => {
    expect(macFromNet0('virtio=bc:24:11:aa:bb:cc,bridge=vmbr0')).toBe('BC:24:11:AA:BB:CC');
    expect(macFromNet0('e1000=BC:24:11:00:00:01,bridge=vmbr0,tag=5')).toBe('BC:24:11:00:00:01');
    expect(macFromNet0(undefined)).toBeNull();
  });
});

describe('usableAddresses', () => {
  it('keeps what a person would connect to, and drops loopback and link-local', () => {
    expect(
      usableAddresses([
        { name: 'lo', 'ip-addresses': [{ 'ip-address': '127.0.0.1', 'ip-address-type': 'ipv4' }] },
        {
          name: 'Ethernet',
          'ip-addresses': [
            { 'ip-address': '192.0.2.20', 'ip-address-type': 'ipv4' },
            { 'ip-address': 'fe80::1', 'ip-address-type': 'ipv6' },
            { 'ip-address': '2001:db8::20', 'ip-address-type': 'ipv6' },
          ],
        },
        {
          name: 'Loopback Pseudo-Interface 1',
          'ip-addresses': [{ 'ip-address': '::1', 'ip-address-type': 'ipv6' }],
        },
      ]),
    ).toEqual(['192.0.2.20', '2001:db8::20']);
  });
});

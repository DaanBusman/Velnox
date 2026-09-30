import { describe, expect, it } from 'vitest';
import {
  GIB,
  SNIFF_BYTES,
  checkCapacity,
  displayUrl,
  importFilename,
  isValidLibraryFilename,
  kindForFilename,
  parseClusterVolumeParams,
  parseFriendlyName,
  parseLibraryPushParams,
  parseVolumeId,
  sniffLibraryContent,
  volumeId,
} from './library';

describe('library filenames', () => {
  it.each([
    'Win11_25H2_Dutch_x64.iso',
    'ubuntu-24.04.3-live-server-amd64.iso',
    'noble-server-cloudimg-amd64.img',
    'debian-13-genericcloud-amd64.qcow2',
    'a.iso',
  ])('accepts %s', (name) => {
    expect(isValidLibraryFilename(name)).toBe(true);
  });

  it.each([
    ['a path', '../etc/passwd'],
    ['a directory separator', 'iso/win.iso'],
    ['a leading dot', '.hidden.iso'],
    ['a double dot', 'win..iso'],
    ['a trailing dot', 'win.iso.'],
    ['a space, which Proxmox would rewrite', 'Windows 11.iso'],
    ['a plus, which Proxmox would rewrite', 'c++.iso'],
    ['nothing', ''],
    ['over 200 characters', `${'a'.repeat(200)}.iso`],
  ])('refuses %s', (_why, name) => {
    expect(isValidLibraryFilename(name)).toBe(false);
  });

  it('takes the kind from the extension, case-insensitively', () => {
    expect(kindForFilename('WIN.ISO')).toBe('ISO');
    expect(kindForFilename('noble.img')).toBe('DISK_IMAGE');
    expect(kindForFilename('disk.qcow2')).toBe('DISK_IMAGE');
    expect(kindForFilename('disk.raw')).toBe('DISK_IMAGE');
    expect(kindForFilename('archive.zip')).toBeNull();
    expect(kindForFilename('template.tar.zst')).toBeNull();
  });

  it('pushes a disk image under the extension its bytes call for', () => {
    expect(importFilename('noble-server-cloudimg-amd64.img', 'qcow2')).toBe(
      'noble-server-cloudimg-amd64.qcow2',
    );
    expect(importFilename('disk.img', 'raw')).toBe('disk.raw');
    expect(importFilename('disk.qcow2', 'qcow2')).toBe('disk.qcow2');
  });

  it('builds and reads volume ids', () => {
    expect(volumeId('local', 'ISO', 'a.iso')).toBe('local:iso/a.iso');
    expect(volumeId('local', 'DISK_IMAGE', 'a.qcow2')).toBe('local:import/a.qcow2');
    expect(parseVolumeId('local:iso/a.iso')).toEqual({
      storage: 'local',
      content: 'iso',
      filename: 'a.iso',
    });
  });

  it.each([
    'local:images/100/vm-100-disk-0.qcow2',
    'local:iso/../../etc/shadow',
    'local:iso/a..iso',
    'local:iso/sub/a.iso',
    'local:backup/vzdump.vma.zst',
    'local',
  ])('refuses the volume id %s', (volid) => {
    expect(parseVolumeId(volid)).toBeNull();
  });
});

describe('friendly names', () => {
  const name = (filename: string) => parseFriendlyName(filename);

  it("reads the owner's own example", () => {
    expect(name('Windows11_25H2_Dutch.iso')).toMatchObject({
      title: 'Windows 11 Version 25H2',
      language: 'nl',
      recognised: true,
    });
  });

  it("reads Microsoft's consumer download names", () => {
    expect(name('Win11_25H2_Dutch_x64.iso')).toMatchObject({
      title: 'Windows 11 Version 25H2',
      language: 'nl',
      arch: 'x64',
    });
    expect(name('Win11_24H2_EnglishInternational_x64v2.iso')).toMatchObject({
      title: 'Windows 11 Version 24H2',
      language: 'en-GB',
      arch: 'x64',
    });
    expect(name('Win10_22H2_BrazilianPortuguese_x64v1.iso')).toMatchObject({
      title: 'Windows 10 Version 22H2',
      language: 'pt-BR',
    });
  });

  it("reads Microsoft's volume-licence names", () => {
    expect(
      name('nl-nl_windows_11_business_editions_version_24h2_x64_dvd_a2a4c1b3.iso'),
    ).toMatchObject({
      title: 'Windows 11 Version 24H2',
      variants: ['businessEditions'],
      language: 'nl',
      arch: 'x64',
    });
    expect(name('en-us_windows_server_2025_x64_dvd_b7ec10f3.iso')).toMatchObject({
      title: 'Windows Server 2025',
      language: 'en-US',
    });
    expect(name('en-gb_windows_server_2012_r2_vl_x64_dvd_3319595.iso').title).toBe(
      'Windows Server 2012 R2',
    );
  });

  it('names Windows Server evaluation builds by their build number', () => {
    expect(
      name('26100.1742.240906-0331.ge_release_svc_refresh_SERVER_EVAL_x64FRE_en-us.iso'),
    ).toMatchObject({
      title: 'Windows Server 2025',
      variants: ['evaluation'],
      language: 'en-US',
      arch: 'x64',
    });
    expect(
      name('20348.169.210806-2348.fe_release_svc_refresh_SERVER_EVAL_x64FRE_en-us.iso').title,
    ).toBe('Windows Server 2022');
    expect(name('SERVER_EVAL_x64FRE_de-de.iso')).toMatchObject({
      title: 'Windows Server',
      language: 'de',
    });
  });

  it('reads Ubuntu, and marks only even-year April releases LTS', () => {
    expect(name('ubuntu-24.04.3-live-server-amd64.iso')).toMatchObject({
      title: 'Ubuntu 24.04.3 LTS',
      variants: ['live', 'server'],
      arch: 'amd64',
      language: null,
    });
    expect(name('ubuntu-25.04-desktop-amd64.iso')).toMatchObject({
      title: 'Ubuntu 25.04',
      variants: ['desktop'],
    });
    expect(name('noble-server-cloudimg-amd64.img')).toMatchObject({
      title: 'Ubuntu 24.04 LTS',
      variants: ['cloudImage'],
      arch: 'amd64',
    });
    expect(name('ubuntu-22.04-server-cloudimg-arm64.img')).toMatchObject({
      title: 'Ubuntu 22.04 LTS',
      variants: ['cloudImage'],
      arch: 'arm64',
    });
  });

  it('reads Debian, with its codename', () => {
    expect(name('debian-13.1.0-amd64-netinst.iso')).toMatchObject({
      title: 'Debian 13.1.0 (trixie)',
      variants: ['netinst'],
      arch: 'amd64',
    });
    expect(name('debian-12-genericcloud-amd64.qcow2')).toMatchObject({
      title: 'Debian 12 (bookworm)',
      variants: ['cloudImage'],
    });
    expect(name('debian-live-12.7.0-amd64-kde.iso').variants).toContain('live');
  });

  it('reads Proxmox and VirtIO', () => {
    expect(name('proxmox-ve_9.0-1.iso').title).toBe('Proxmox VE 9.0');
    expect(name('proxmox-backup-server_4.0-1.iso').title).toBe('Proxmox Backup Server 4.0');
    expect(name('virtio-win-0.1.271.iso')).toMatchObject({
      title: 'VirtIO-win 0.1.271',
      variants: ['drivers'],
    });
  });

  it('reads x86_64 as one architecture, not as x86', () => {
    expect(name('CentOS-Stream-10-latest-x86_64-dvd1.iso').arch).toBe('x86_64');
  });

  it('keeps an unrecognised filename and says so', () => {
    expect(name('customer-golden-image-v3.iso')).toEqual({
      title: 'customer-golden-image-v3',
      variants: [],
      language: null,
      arch: null,
      recognised: false,
    });
  });

  it('does not invent a language from a word that merely contains one', () => {
    // "Germany" is not "German", and a filename about a place is not in a language.
    expect(name('Germany-office-build.iso').language).toBeNull();
  });
});

describe('job parameters', () => {
  const ids = {
    itemId: '4a9d1c33-7e0c-4f35-9b1e-6a8d0c3e2f11',
    clusterId: '7aca66b8-fce5-46e1-be80-46e89221de55',
  };

  it('accepts a well-formed push', () => {
    expect(parseLibraryPushParams({ ...ids, node: 'pve1', storage: 'local' })).toEqual({
      ...ids,
      node: 'pve1',
      storage: 'local',
    });
  });

  it.each([
    ['a node with a slash', { node: 'pve1/../x', storage: 'local' }],
    ['an empty storage', { node: 'pve1', storage: '' }],
    ['a non-uuid item', { node: 'pve1', storage: 'local', itemId: 'x' }],
  ])('refuses %s', (_why, extra) => {
    expect(() => parseLibraryPushParams({ ...ids, ...extra })).toThrow();
  });

  it('refuses a volume on a different storage from the one named', () => {
    // Otherwise a permission check could look at one storage while the delete
    // acted on another.
    expect(() =>
      parseClusterVolumeParams({
        clusterId: ids.clusterId,
        node: 'pve1',
        storage: 'local',
        volid: 'nas:iso/a.iso',
      }),
    ).toThrow();
  });
});

describe('capacity', () => {
  const base = {
    ceilingBytes: 100 * GIB,
    usedBytes: 60 * GIB,
    diskFreeBytes: 50 * GIB,
    diskFloorBytes: 10 * GIB,
  };

  it('allows what fits under both limits', () => {
    expect(checkCapacity(base, 30 * GIB)).toBeNull();
  });

  it('names the ceiling when the library is full', () => {
    expect(checkCapacity(base, 41 * GIB)).toEqual({
      code: 'library.full',
      params: { ceilingGb: 100, usedGb: 60, requestedGb: 41 },
    });
  });

  it('names the floor when the disk would drop below it, even under the ceiling', () => {
    expect(checkCapacity({ ...base, diskFreeBytes: 35 * GIB }, 30 * GIB)).toEqual({
      code: 'library.disk_low',
      params: { freeGb: 35, floorGb: 10, requestedGb: 30 },
    });
  });

  it('lands exactly on either limit without refusing', () => {
    expect(checkCapacity(base, 40 * GIB)).toBeNull();
    expect(checkCapacity({ ...base, diskFreeBytes: 40 * GIB }, 30 * GIB)).toBeNull();
  });
});

describe('what the bytes are', () => {
  const at = (offset: number, text: string, size = SNIFF_BYTES) => {
    const bytes = new Uint8Array(size);
    bytes.set(
      [...text].map((c) => c.charCodeAt(0)),
      offset,
    );
    return bytes;
  };

  it('recognises ISO 9660 and UDF by the first volume descriptor', () => {
    expect(sniffLibraryContent(at(0x8001, 'CD001')).iso).toBe(true);
    expect(sniffLibraryContent(at(0x8001, 'BEA01')).iso).toBe(true);
  });

  it('does not take an HTML error page for an ISO', () => {
    expect(sniffLibraryContent(at(0, '<!DOCTYPE html><title>403</title>'))).toEqual({
      iso: false,
      qcow2: false,
    });
  });

  it('does not read past a file too short to be an ISO', () => {
    expect(sniffLibraryContent(at(0, 'CD001', 100)).iso).toBe(false);
  });

  it('recognises the qcow2 magic', () => {
    const qcow = new Uint8Array(SNIFF_BYTES);
    qcow.set([0x51, 0x46, 0x49, 0xfb]);
    expect(sniffLibraryContent(qcow)).toEqual({ iso: false, qcow2: true });
    expect(sniffLibraryContent(qcow.subarray(0, 4)).qcow2).toBe(true);
  });
});

describe('how a URL is shown', () => {
  it('drops the query, which is where a signed link keeps its token', () => {
    expect(
      displayUrl(
        'https://software.download.prss.microsoft.com/dbazure/Win11_25H2_Dutch_x64.iso?t=abc&e=123&h=secret',
      ),
    ).toBe('https://software.download.prss.microsoft.com/dbazure/Win11_25H2_Dutch_x64.iso?…');
  });

  it('drops credentials in the authority', () => {
    expect(displayUrl('https://user:pass@files.example.com/a.iso')).toBe(
      'https://files.example.com/a.iso',
    );
  });

  it('leaves a plain URL alone', () => {
    expect(displayUrl('http://10.0.0.5:8080/isos/a.iso')).toBe('http://10.0.0.5:8080/isos/a.iso');
  });
});

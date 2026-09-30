import { windowsTemplateSchema } from '@velnox/shared';
import { describe, expect, it } from 'vitest';
import {
  buildAutounattend,
  unattendPassword,
  virtioFolders,
  WINDOWS_DONE_MARKER,
  xml,
} from './autounattend';

const template = (overrides: Record<string, unknown> = {}) =>
  windowsTemplateSchema.parse({
    family: 'WINDOWS',
    isoFilename: 'Win11_25H2_Dutch_x64.iso',
    imageName: 'Windows 11 Pro',
    virtioIsoFilename: 'virtio-win-0.1.271.iso',
    accounts: [{ name: 'beheer', displayName: 'Beheer', administrator: true }],
    ...overrides,
  });

const base = {
  hostname: 'WS-001',
  macAddress: 'bc:24:11:aa:bb:cc',
  network: { mode: 'DHCP' as const },
  passwords: { administrator: 'Adm1n&<"secret>', beheer: 'Beheer-Pass-1' },
  productKey: null,
};

/** The text of every element with this name, in document order. */
const all = (doc: string, tag: string) =>
  [...doc.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))].map((m) => m[1] ?? '');

describe('unattendPassword', () => {
  it('is what Windows SIM writes for a hidden password', () => {
    // "Password" + suffix, UTF-16LE, base64 — the form SIM produces with "Hide Sensitive Data".
    expect(unattendPassword('Secret1', 'Password')).toBe(
      Buffer.from('Secret1Password', 'utf16le').toString('base64'),
    );
    expect(Buffer.from(unattendPassword('x', 'AdministratorPassword'), 'base64').toString('utf16le')).toBe(
      'xAdministratorPassword',
    );
  });
});

describe('buildAutounattend', () => {
  const doc = buildAutounattend({ ...base, settings: template() });

  it('never contains a password in the clear', () => {
    expect(doc).not.toContain('Adm1n');
    expect(doc).not.toContain('Beheer-Pass-1');
    expect(all(doc, 'PlainText')).toEqual(['false', 'false', 'false']);
  });

  it('escapes what XML would read as markup', () => {
    expect(xml(`a&b<c>"d'`)).toBe('a&amp;b&lt;c&gt;&quot;d&apos;');
    const odd = buildAutounattend({
      ...base,
      settings: template({ imageName: 'Windows 11 Pro <N> & "Edu"' }),
    });
    expect(odd).toContain('<Value>Windows 11 Pro &lt;N&gt; &amp; &quot;Edu&quot;</Value>');
  });

  it('chooses the edition by the name in the ISO image list', () => {
    expect(doc).toMatch(/<Key>\/IMAGE\/NAME<\/Key>\s*<Value>Windows 11 Pro<\/Value>/);
  });

  it('keeps the four locale fields and the time zone apart', () => {
    const nl = buildAutounattend({
      ...base,
      settings: template({
        locale: {
          uiLanguage: 'nl-NL',
          systemLocale: 'nl-NL',
          userLocale: 'nl-NL',
          inputLocale: '0413:00020409',
          timeZone: 'W. Europe Standard Time',
        },
      }),
    });
    expect(all(nl, 'InputLocale')).toEqual(['0413:00020409', '0413:00020409']);
    expect(all(nl, 'UILanguage')).toEqual(['nl-NL', 'nl-NL', 'nl-NL']);
    expect(all(nl, 'TimeZone')).toEqual(['W. Europe Standard Time', 'W. Europe Standard Time']);
  });

  it('partitions GPT for UEFI by default, and installs to the third partition', () => {
    expect(doc).toContain('<Type>EFI</Type>');
    expect(doc).toContain('<Type>MSR</Type>');
    expect(doc).toMatch(/<InstallTo><DiskID>0<\/DiskID><PartitionID>3<\/PartitionID><\/InstallTo>/);
  });

  it('partitions MBR with an active system partition when asked, on a server', () => {
    const mbr = buildAutounattend({
      ...base,
      settings: template({ imageName: 'Windows Server 2022 SERVERSTANDARD', diskLayout: 'MBR', accounts: [] }),
    });
    expect(mbr).not.toContain('<Type>EFI</Type>');
    expect(mbr).toContain('<Active>true</Active>');
    expect(mbr).toMatch(/<PartitionID>2<\/PartitionID><\/InstallTo>/);
  });

  it('leaves the product key empty when there is none, so Setup does not stop for one', () => {
    expect(doc).toContain('<ProductKey><Key></Key><WillShowUI>Never</WillShowUI></ProductKey>');
    const keyed = buildAutounattend({ ...base, productKey: 'VK7JG-NPHTM-C97JM-9MPGT-3V66T', settings: template() });
    expect(keyed).toContain('<Key>VK7JG-NPHTM-C97JM-9MPGT-3V66T</Key>');
  });

  it('loads VirtIO storage and network drivers in Setup from the right folder', () => {
    expect(doc).toContain('<Path>D:\\vioscsi\\w11\\amd64</Path>');
    expect(doc).toContain('<Path>E:\\NetKVM\\w11\\amd64</Path>');
    expect(buildAutounattend({ ...base, settings: template({ virtio: false }) })).not.toContain('DriverPaths');
    expect(virtioFolders('Windows Server 2025 Datacenter (Desktop Experience)')).toEqual(['2k25']);
    expect(virtioFolders('Something new')).toContain('w11');
  });

  it('creates the accounts with their groups', () => {
    expect(doc).toMatch(/<Name>beheer<\/Name>\s*<DisplayName>Beheer<\/DisplayName>\s*<Group>Administrators<\/Group>/);
  });

  it('logs on once, and the first logon removes the auto-logon and its stored password', () => {
    expect(doc).toContain('<LogonCount>1</LogonCount>');
    const commands = all(doc, 'CommandLine');
    expect(commands.some((c) => c.includes('AutoAdminLogon') && c.includes('/d 0'))).toBe(true);
    expect(commands.some((c) => c.includes('DefaultPassword'))).toBe(true);
  });

  it('installs the drivers and the guest agent from whichever drive has the VirtIO ISO', () => {
    const commands = all(doc, 'CommandLine');
    expect(commands[0]).toContain('virtio-win-gt-x64.msi');
    expect(commands[1]).toContain('qemu-ga-x86_64.msi');
    expect(commands[0]).toContain('for %d in (D E F G H)');
  });

  it('switches the built-in Administrator off on a desktop edition, and not on a server', () => {
    expect(all(doc, 'CommandLine')).toContain('net user Administrator /active:no');
    const server = buildAutounattend({
      ...base,
      settings: template({ imageName: 'Windows Server 2025 Standard', accounts: [] }),
    });
    expect(all(server, 'CommandLine')).not.toContain('net user Administrator /active:no');
  });

  it('writes the done marker as the very last command', () => {
    const commands = all(doc, 'CommandLine');
    expect(commands[commands.length - 1]).toContain(WINDOWS_DONE_MARKER.replace(/\\/g, '\\'));
    const orders = all(doc, 'Order').map(Number);
    expect(orders.slice(-commands.length)).toEqual(commands.map((_, i) => i + 1));
  });

  it('opens RDP by the firewall group id, which no translation changes', () => {
    expect(doc).not.toContain('fDenyTSConnections');
    const rdp = buildAutounattend({ ...base, settings: template({ rdp: true }) });
    expect(rdp).toContain('<fDenyTSConnections>false</fDenyTSConnections>');
    expect(rdp).toContain('<Group>@FirewallAPI.dll,-28752</Group>');
  });

  it('addresses a static configuration to the NIC by its MAC', () => {
    const fixed = buildAutounattend({
      ...base,
      settings: template(),
      network: { mode: 'STATIC', address: '192.0.2.20/24', gateway: '192.0.2.1', dns: ['192.0.2.53'] },
    });
    expect(all(fixed, 'Identifier')).toContain('BC-24-11-AA-BB-CC');
    expect(fixed).toContain('192.0.2.20/24');
    expect(fixed).toContain('<NextHopAddress>192.0.2.1</NextHopAddress>');
    expect(doc).not.toContain('Microsoft-Windows-TCPIP');
  });

  it('refuses to build when a password was not decided', () => {
    expect(() => buildAutounattend({ ...base, passwords: { administrator: 'x' }, settings: template() })).toThrow(
      /beheer/,
    );
  });
});

describe('windowsTemplateSchema', () => {
  it('refuses Windows 11 on MBR', () => {
    expect(() => template({ diskLayout: 'MBR' })).toThrow(/GPT/);
  });

  it('refuses a desktop edition with nobody to administer it', () => {
    expect(() => template({ accounts: [{ name: 'user' }] })).toThrow(/administrator account/);
  });

  it('refuses a reserved account name', () => {
    expect(() => template({ accounts: [{ name: 'Administrator', administrator: true }] })).toThrow(/reserved/);
  });

  it('needs the VirtIO ISO for either switch', () => {
    expect(() => template({ virtioIsoFilename: null })).toThrow(/VirtIO/);
    expect(() => template({ virtioIsoFilename: null, virtio: false, guestAgent: false })).not.toThrow();
  });
});

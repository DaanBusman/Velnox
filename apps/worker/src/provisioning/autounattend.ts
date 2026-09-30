import type { ProvisionNetwork, WindowsTemplate } from '@velnox/shared';

/**
 * A Windows template turned into Autounattend.xml.
 *
 * Setup finds the file at the root of any removable drive — here a small ISO
 * (see iso9660.ts) — and runs three passes from it: `windowsPE` partitions the
 * disk and picks the edition, `specialize` names the machine and its network,
 * and `oobeSystem` creates the accounts and skips every screen someone would
 * otherwise click through.
 *
 * **Passwords are obfuscated, not encrypted.** Unattend's `PlainText=false` is
 * base64 of the UTF-16 password with a fixed suffix, and anyone with the file
 * can reverse it. So the file lives only as long as the install: the answer ISO
 * is deleted from the storage when provisioning ends, however it ends (ADR-039).
 *
 * The first logon, which one auto-logon provides, installs the VirtIO drivers
 * and the guest agent from the VirtIO ISO, applies the power settings, removes
 * the auto-logon — including the `DefaultPassword` value Windows otherwise
 * leaves in the registry in the clear — and writes a marker file last. Velnox
 * reads that marker through the guest agent to know the install has finished.
 */

/** Written last at first logon; Velnox reads it through the guest agent. */
export const WINDOWS_DONE_MARKER = 'C:\\Windows\\Temp\\velnox-provisioned.txt';

export interface AutounattendInput {
  settings: WindowsTemplate;
  /** Without a domain, 15 characters at most — checked before this is called. */
  hostname: string;
  /** The first NIC's MAC as Proxmox reports it; used to address it for a static configuration. */
  macAddress: string;
  network: ProvisionNetwork;
  /** Plaintext, decided for this VM: `administrator`, and one per account name. */
  passwords: Record<string, string>;
  productKey: string | null;
}

const PUBLIC_KEY_TOKEN = '31bf3856ad364e35';
const HIGH_PERFORMANCE = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c';
const BALANCED = '381b4222-f694-41f0-9685-ff5bb260df2e';
/** The drive letters the VirtIO ISO can land on; Setup ignores the paths that do not exist. */
const DRIVE_LETTERS = ['D', 'E', 'F', 'G', 'H'];

/** XML text and attribute content. */
export function xml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Unattend's `PlainText=false` encoding: UTF-16LE of the value plus a fixed suffix, in base64. */
export function unattendPassword(password: string, suffix: 'Password' | 'AdministratorPassword'): string {
  return Buffer.from(password + suffix, 'utf16le').toString('base64');
}

export const isServerEdition = (imageName: string): boolean => /server/i.test(imageName);

/**
 * The VirtIO ISO's folder for this Windows, from the edition name.
 *
 * The ISO keeps drivers per Windows release — `w11`, `2k22` — and a driver from
 * the wrong folder is refused by Setup at best. Unknown names get the recent
 * ones, which Setup narrows down itself by reading each driver's target.
 */
export function virtioFolders(imageName: string): string[] {
  const name = imageName.toLowerCase();
  if (/server\s*2025/.test(name)) return ['2k25'];
  if (/server\s*2022/.test(name)) return ['2k22'];
  if (/server\s*2019/.test(name)) return ['2k19'];
  if (/server\s*2016/.test(name)) return ['2k16'];
  if (/windows\s*11/.test(name)) return ['w11'];
  if (/windows\s*10/.test(name)) return ['w10'];
  return ['w11', '2k25', '2k22', 'w10'];
}

const component = (name: string, body: string): string =>
  `    <component name="${name}" processorArchitecture="amd64" publicKeyToken="${PUBLIC_KEY_TOKEN}" language="neutral" versionScope="nonSxS" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n${body}    </component>\n`;

function internationalCore(settings: WindowsTemplate, winPE: boolean): string {
  const l = settings.locale;
  const setupLanguage = winPE
    ? `      <SetupUILanguage>\n        <UILanguage>${xml(l.uiLanguage)}</UILanguage>\n      </SetupUILanguage>\n`
    : '';
  return (
    setupLanguage +
    `      <InputLocale>${xml(l.inputLocale)}</InputLocale>\n` +
    `      <SystemLocale>${xml(l.systemLocale)}</SystemLocale>\n` +
    `      <UILanguage>${xml(l.uiLanguage)}</UILanguage>\n` +
    `      <UserLocale>${xml(l.userLocale)}</UserLocale>\n`
  );
}

function diskConfiguration(settings: WindowsTemplate): { disk: string; partition: number } {
  if (settings.diskLayout === 'GPT') {
    return {
      partition: 3,
      disk:
        '      <DiskConfiguration>\n' +
        '        <WillShowUI>OnError</WillShowUI>\n' +
        '        <Disk wcm:action="add">\n' +
        '          <DiskID>0</DiskID>\n' +
        '          <WillWipeDisk>true</WillWipeDisk>\n' +
        '          <CreatePartitions>\n' +
        '            <CreatePartition wcm:action="add"><Order>1</Order><Type>EFI</Type><Size>260</Size></CreatePartition>\n' +
        '            <CreatePartition wcm:action="add"><Order>2</Order><Type>MSR</Type><Size>16</Size></CreatePartition>\n' +
        '            <CreatePartition wcm:action="add"><Order>3</Order><Type>Primary</Type><Extend>true</Extend></CreatePartition>\n' +
        '          </CreatePartitions>\n' +
        '          <ModifyPartitions>\n' +
        '            <ModifyPartition wcm:action="add"><Order>1</Order><PartitionID>1</PartitionID><Format>FAT32</Format><Label>System</Label></ModifyPartition>\n' +
        '            <ModifyPartition wcm:action="add"><Order>2</Order><PartitionID>2</PartitionID></ModifyPartition>\n' +
        '            <ModifyPartition wcm:action="add"><Order>3</Order><PartitionID>3</PartitionID><Format>NTFS</Format><Label>Windows</Label><Letter>C</Letter></ModifyPartition>\n' +
        '          </ModifyPartitions>\n' +
        '        </Disk>\n' +
        '      </DiskConfiguration>\n',
    };
  }
  return {
    partition: 2,
    disk:
      '      <DiskConfiguration>\n' +
      '        <WillShowUI>OnError</WillShowUI>\n' +
      '        <Disk wcm:action="add">\n' +
      '          <DiskID>0</DiskID>\n' +
      '          <WillWipeDisk>true</WillWipeDisk>\n' +
      '          <CreatePartitions>\n' +
      '            <CreatePartition wcm:action="add"><Order>1</Order><Type>Primary</Type><Size>500</Size></CreatePartition>\n' +
      '            <CreatePartition wcm:action="add"><Order>2</Order><Type>Primary</Type><Extend>true</Extend></CreatePartition>\n' +
      '          </CreatePartitions>\n' +
      '          <ModifyPartitions>\n' +
      '            <ModifyPartition wcm:action="add"><Order>1</Order><PartitionID>1</PartitionID><Format>NTFS</Format><Label>System</Label><Active>true</Active></ModifyPartition>\n' +
      '            <ModifyPartition wcm:action="add"><Order>2</Order><PartitionID>2</PartitionID><Format>NTFS</Format><Label>Windows</Label><Letter>C</Letter></ModifyPartition>\n' +
      '          </ModifyPartitions>\n' +
      '        </Disk>\n' +
      '      </DiskConfiguration>\n',
  };
}

function windowsPE(settings: WindowsTemplate, productKey: string | null): string {
  let out = component(
    'Microsoft-Windows-International-Core-WinPE',
    internationalCore(settings, true),
  );

  if (settings.virtio) {
    // Storage and network drivers Setup needs to see the disk at all.
    let key = 1;
    let paths = '';
    for (const folder of virtioFolders(settings.imageName)) {
      for (const driver of ['vioscsi', 'viostor', 'NetKVM']) {
        for (const letter of DRIVE_LETTERS) {
          paths +=
            `        <PathAndCredentials wcm:action="add" wcm:keyValue="${key}">\n` +
            `          <Path>${letter}:\\${driver}\\${folder}\\amd64</Path>\n` +
            '        </PathAndCredentials>\n';
          key += 1;
        }
      }
    }
    out += component(
      'Microsoft-Windows-PnpCustomizationsWinPE',
      `      <DriverPaths>\n${paths}      </DriverPaths>\n`,
    );
  }

  const { disk, partition } = diskConfiguration(settings);
  const setup =
    disk +
    '      <ImageInstall>\n' +
    '        <OSImage>\n' +
    '          <InstallFrom>\n' +
    '            <MetaData wcm:action="add">\n' +
    '              <Key>/IMAGE/NAME</Key>\n' +
    `              <Value>${xml(settings.imageName)}</Value>\n` +
    '            </MetaData>\n' +
    '          </InstallFrom>\n' +
    `          <InstallTo><DiskID>0</DiskID><PartitionID>${partition}</PartitionID></InstallTo>\n` +
    '          <WillShowUI>OnError</WillShowUI>\n' +
    '        </OSImage>\n' +
    '      </ImageInstall>\n' +
    '      <UserData>\n' +
    '        <AcceptEula>true</AcceptEula>\n' +
    // No key: an empty one, and Setup carries on. Windows asks at activation
    // for an edition that needs one, which is what installing by hand does.
    `        <ProductKey><Key>${xml(productKey ?? '')}</Key><WillShowUI>Never</WillShowUI></ProductKey>\n` +
    '      </UserData>\n' +
    '      <DynamicUpdate>\n' +
    `        <Enable>${settings.windowsUpdate === 'DURING_SETUP' ? 'true' : 'false'}</Enable>\n` +
    '        <WillShowUI>Never</WillShowUI>\n' +
    '      </DynamicUpdate>\n';
  out += component('Microsoft-Windows-Setup', setup);
  return out;
}

/** Windows' notation for a MAC in unattend: dashes, upper case. */
const windowsMac = (mac: string) => mac.toUpperCase().replace(/:/g, '-');

function specialize(input: AutounattendInput): string {
  const { settings } = input;
  let out = component(
    'Microsoft-Windows-Shell-Setup',
    `      <ComputerName>${xml(input.hostname)}</ComputerName>\n` +
      `      <TimeZone>${xml(settings.locale.timeZone)}</TimeZone>\n`,
  );
  out += component(
    'Microsoft-Windows-UnattendedJoin',
    `      <Identification>\n        <JoinWorkgroup>${xml(settings.workgroup)}</JoinWorkgroup>\n      </Identification>\n`,
  );
  if (settings.rdp) {
    out += component(
      'Microsoft-Windows-TerminalServices-LocalSessionManager',
      '      <fDenyTSConnections>false</fDenyTSConnections>\n',
    );
    // By resource id, not by name: the group's name is translated, the id is not.
    out += component(
      'Networking-MPSSVC-Svc',
      '      <FirewallGroups>\n' +
        '        <FirewallGroup wcm:action="add" wcm:keyValue="RemoteDesktop">\n' +
        '          <Active>true</Active>\n' +
        '          <Group>@FirewallAPI.dll,-28752</Group>\n' +
        '          <Profile>all</Profile>\n' +
        '        </FirewallGroup>\n' +
        '      </FirewallGroups>\n',
    );
  }
  if (input.network.mode === 'STATIC') {
    const mac = windowsMac(input.macAddress);
    const [address, prefix] = input.network.address.split('/');
    out += component(
      'Microsoft-Windows-TCPIP',
      '      <Interfaces>\n' +
        '        <Interface wcm:action="add">\n' +
        `          <Identifier>${mac}</Identifier>\n` +
        '          <Ipv4Settings><DhcpEnabled>false</DhcpEnabled></Ipv4Settings>\n' +
        '          <UnicastIpAddresses>\n' +
        `            <IpAddress wcm:action="add" wcm:keyValue="1">${xml(`${address}/${prefix}`)}</IpAddress>\n` +
        '          </UnicastIpAddresses>\n' +
        '          <Routes>\n' +
        '            <Route wcm:action="add">\n' +
        '              <Identifier>0</Identifier>\n' +
        '              <Prefix>0.0.0.0/0</Prefix>\n' +
        `              <NextHopAddress>${xml(input.network.gateway)}</NextHopAddress>\n` +
        '            </Route>\n' +
        '          </Routes>\n' +
        '        </Interface>\n' +
        '      </Interfaces>\n',
    );
    out += component(
      'Microsoft-Windows-DNS-Client',
      '      <Interfaces>\n' +
        '        <Interface wcm:action="add">\n' +
        `          <Identifier>${mac}</Identifier>\n` +
        '          <DNSServerSearchOrder>\n' +
        input.network.dns
          .map((ip, i) => `            <IpAddress wcm:action="add" wcm:keyValue="${i + 1}">${xml(ip)}</IpAddress>\n`)
          .join('') +
        '          </DNSServerSearchOrder>\n' +
        '        </Interface>\n' +
        '      </Interfaces>\n',
    );
  }
  return out;
}

function firstLogonCommands(settings: WindowsTemplate): string[] {
  const commands: string[] = [];
  const onAnyDrive = (path: string, run: string) =>
    `cmd /c for %d in (${DRIVE_LETTERS.join(' ')}) do if exist %d:\\${path} ${run.replace(/\{\}/g, `%d:\\${path}`)}`;

  if (settings.virtio) {
    commands.push(onAnyDrive('virtio-win-gt-x64.msi', 'msiexec /i {} /qn /norestart ADDLOCAL=ALL'));
  }
  if (settings.guestAgent) {
    commands.push(onAnyDrive('guest-agent\\qemu-ga-x86_64.msi', 'msiexec /i {} /qn /norestart'));
  }
  commands.push(`powercfg /setactive ${settings.powerPlan === 'HIGH_PERFORMANCE' ? HIGH_PERFORMANCE : BALANCED}`);
  if (!settings.hibernation) commands.push('powercfg /hibernate off');
  // Auto-logon ends here, and so does the password Windows keeps for it in the
  // registry in the clear.
  commands.push(
    'reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon" /v AutoAdminLogon /t REG_SZ /d 0 /f',
  );
  commands.push(
    'cmd /c reg delete "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon" /v DefaultPassword /f 2>nul & exit /b 0',
  );
  if (!isServerEdition(settings.imageName)) {
    // A desktop edition's built-in Administrator exists only for this one
    // logon; the accounts the template names are the ones people use.
    commands.push('net user Administrator /active:no');
  }
  // Last: its presence means everything above has run.
  commands.push(`cmd /c echo velnox> ${WINDOWS_DONE_MARKER}`);
  return commands;
}

function oobeSystem(input: AutounattendInput): string {
  const { settings, passwords } = input;
  const administrator = passwords.administrator;
  if (!administrator) throw new Error('No password was decided for Administrator');

  let accounts = '';
  for (const account of settings.accounts) {
    const password = passwords[account.name];
    if (!password) throw new Error(`No password was decided for ${account.name}`);
    accounts +=
      '          <LocalAccount wcm:action="add">\n' +
      `            <Name>${xml(account.name)}</Name>\n` +
      `            <DisplayName>${xml(account.displayName || account.name)}</DisplayName>\n` +
      `            <Group>${account.administrator ? 'Administrators' : 'Users'}</Group>\n` +
      '            <Password>\n' +
      `              <Value>${unattendPassword(password, 'Password')}</Value>\n` +
      '              <PlainText>false</PlainText>\n' +
      '            </Password>\n' +
      '          </LocalAccount>\n';
  }

  const commands = firstLogonCommands(settings)
    .map(
      (command, i) =>
        '        <SynchronousCommand wcm:action="add">\n' +
        `          <Order>${i + 1}</Order>\n` +
        `          <CommandLine>${xml(command)}</CommandLine>\n` +
        '        </SynchronousCommand>\n',
    )
    .join('');

  const shell =
    '      <OOBE>\n' +
    '        <HideEULAPage>true</HideEULAPage>\n' +
    '        <HideOEMRegistrationScreen>true</HideOEMRegistrationScreen>\n' +
    '        <HideOnlineAccountScreens>true</HideOnlineAccountScreens>\n' +
    '        <HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE>\n' +
    `        <HideLocalAccountScreen>true</HideLocalAccountScreen>\n` +
    '        <ProtectYourPC>3</ProtectYourPC>\n' +
    '      </OOBE>\n' +
    '      <UserAccounts>\n' +
    '        <AdministratorPassword>\n' +
    `          <Value>${unattendPassword(administrator, 'AdministratorPassword')}</Value>\n` +
    '          <PlainText>false</PlainText>\n' +
    '        </AdministratorPassword>\n' +
    (accounts ? `        <LocalAccounts>\n${accounts}        </LocalAccounts>\n` : '') +
    '      </UserAccounts>\n' +
    // One logon, to run the commands below; they end it.
    '      <AutoLogon>\n' +
    '        <Enabled>true</Enabled>\n' +
    '        <LogonCount>1</LogonCount>\n' +
    '        <Username>Administrator</Username>\n' +
    '        <Password>\n' +
    `          <Value>${unattendPassword(administrator, 'Password')}</Value>\n` +
    '          <PlainText>false</PlainText>\n' +
    '        </Password>\n' +
    '      </AutoLogon>\n' +
    `      <FirstLogonCommands>\n${commands}      </FirstLogonCommands>\n` +
    `      <TimeZone>${xml(settings.locale.timeZone)}</TimeZone>\n`;

  return (
    component('Microsoft-Windows-International-Core', internationalCore(settings, false)) +
    component('Microsoft-Windows-Shell-Setup', shell)
  );
}

export function buildAutounattend(input: AutounattendInput): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<!-- Written by Velnox. It holds obfuscated passwords, and is deleted from the storage when provisioning ends. -->\n' +
    '<unattend xmlns="urn:schemas-microsoft-com:unattend" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">\n' +
    '  <settings pass="windowsPE">\n' +
    windowsPE(input.settings, input.productKey) +
    '  </settings>\n' +
    '  <settings pass="specialize">\n' +
    specialize(input) +
    '  </settings>\n' +
    '  <settings pass="oobeSystem">\n' +
    oobeSystem(input) +
    '  </settings>\n' +
    '</unattend>\n'
  );
}

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { windowsTemplateSchema } from '@velnox/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAutounattend, WINDOWS_DONE_MARKER } from './autounattend';
import { buildIso, isoLayout, isoStream } from './iso9660';
import {
  PACKAGES_RESULT,
  PACKAGES_SCRIPT,
  describeExitCode,
  packageCdName,
  packageScript,
  packageSucceeded,
  packagesFirstLogonCommand,
  packagesScript,
  parsePackageResults,
  type PackageToRun,
} from './packages';

const agent: PackageToRun = {
  filename: 'Agent Setup (x64).msi',
  kind: 'MSI',
  arguments: 'SERVER="https://rmm.example" /qn /norestart',
  runAs: 'SYSTEM',
  required: true,
};
const viewer: PackageToRun = {
  filename: 'viewer.exe',
  kind: 'EXE',
  arguments: '/S',
  runAs: 'ADMINISTRATOR',
  required: false,
};

describe('packageScript', () => {
  it('runs an MSI through msiexec, waiting, with a verbose log and the arguments as written', () => {
    const text = packageScript(0, agent).toString('utf8');
    expect(text).toContain(
      'start "" /wait msiexec /i "%~dp0P01.MSI" /l*v "C:\\Windows\\Temp\\velnox-packages\\01.log" SERVER="https://rmm.example" /qn /norestart',
    );
    expect(text).toContain('>"C:\\Windows\\Temp\\velnox-packages\\01.exit" echo %VELNOX_RC%');
  });

  it('runs an EXE directly, waiting', () => {
    expect(packageScript(1, viewer).toString('utf8')).toContain('start "" /wait "%~dp0P02.EXE" /S');
  });

  it('ends every line in CRLF, which is what cmd reads', () => {
    const text = packageScript(0, agent).toString('utf8');
    expect(
      text
        .split('\n')
        .slice(0, -1)
        .every((line) => line.endsWith('\r')),
    ).toBe(true);
  });

  it('puts the redirection first, so a single-digit exit code is not read as a handle', () => {
    // `echo 0>file` would redirect handle 0; `>file echo 0` writes "0".
    expect(packageScript(0, agent).toString('utf8')).not.toMatch(/echo %VELNOX_RC%>/);
  });
});

describe('packagesScript', () => {
  const text = packagesScript([agent, viewer]).toString('utf8');

  it('runs the packages in order, each in the way the template says', () => {
    const first = text.indexOf('call :system 01');
    const second = text.indexOf('call :admin 02');
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
  });

  it('stops at a required package that failed, and records that it stopped', () => {
    expect(text).toContain('call :record 01 1');
    expect(text).toContain('call :record 02 0');
    expect(text).toContain('if errorlevel 1 goto stopped');
    expect(text).toContain('>>"%VELNOX_RESULT%" echo stopped');
  });

  it('counts 0, 3010 and 1641 as installed', () => {
    for (const code of [0, 3010, 1641])
      expect(text).toContain(`if "%VELNOX_CODE%"=="${code}" exit /b 0`);
  });

  it('runs a SYSTEM package as a one-off scheduled task, and waits for its exit code', () => {
    expect(text).toContain('/ru SYSTEM /rl HIGHEST');
    expect(text).toContain('/tr "cmd /c \\"%VELNOX_CD%P%1.CMD\\""');
    expect(text).toContain(':system_wait');
    expect(text).toContain('schtasks /delete');
  });

  it('remembers its own drive at the top, not inside a subroutine', () => {
    // In a called label %~dp0 is not the script's folder.
    const lines = text.split('\r\n');
    expect(lines.filter((line) => line.includes('%~dp0'))).toEqual(['set "VELNOX_CD=%~dp0"']);
  });

  it('writes where Velnox reads', () => {
    expect(text).toContain(`set "VELNOX_RESULT=${PACKAGES_RESULT}"`);
  });
});

describe('parsePackageResults', () => {
  it('reads each package and whether the script finished', () => {
    expect(parsePackageResults('01 0\r\n02 3010\r\ndone\r\n')).toEqual({
      outcomes: [
        { index: 0, exitCode: 0 },
        { index: 1, exitCode: 3010 },
      ],
      finished: true,
      stopped: false,
    });
  });

  it('knows a stopped run, and an unfinished one', () => {
    expect(parsePackageResults('01 1603\r\nstopped\r\n')).toMatchObject({
      stopped: true,
      finished: true,
    });
    expect(parsePackageResults('01 0\r\n').finished).toBe(false);
    expect(parsePackageResults('').outcomes).toEqual([]);
  });

  it('takes negative codes, which an EXE can return', () => {
    expect(parsePackageResults('01 -2\r\n').outcomes).toEqual([{ index: 0, exitCode: -2 }]);
  });
});

describe('exit codes', () => {
  it('says what the common ones mean', () => {
    expect(packageSucceeded(0)).toBe(true);
    expect(packageSucceeded(3010)).toBe(true);
    expect(packageSucceeded(1603)).toBe(false);
    expect(describeExitCode(1603)).toContain('1603');
    expect(describeExitCode(-2)).toContain('SYSTEM');
  });
});

describe('the packages CD', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'velnox-packages-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('streams the same image buildIso writes, reading the package from disk', async () => {
    const bytes = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(5000, 7),
    ]);
    const path = join(dir, 'agent');
    await writeFile(path, bytes);
    const date = new Date('2026-10-08T12:00:00Z');
    const script = packagesScript([agent]);
    const fromDisk = isoLayout({
      label: 'VELNOXPKG',
      date,
      files: [
        { name: PACKAGES_SCRIPT, content: script },
        { name: packageCdName(0, 'MSI'), path, size: bytes.length },
      ],
    });
    const chunks: Buffer[] = [];
    for await (const chunk of isoStream(fromDisk)) chunks.push(chunk);
    const streamed = Buffer.concat(chunks);
    const inMemory = buildIso({
      label: 'VELNOXPKG',
      date,
      files: [
        { name: PACKAGES_SCRIPT, content: script },
        { name: packageCdName(0, 'MSI'), content: bytes },
      ],
    });
    expect(streamed.length).toBe(fromDisk.size);
    expect(streamed.equals(inMemory)).toBe(true);
  });

  it('refuses a file that changed size since it was laid out', async () => {
    const path = join(dir, 'short');
    await writeFile(path, Buffer.alloc(10));
    const layout = isoLayout({
      label: 'VELNOXPKG',
      files: [{ name: 'P01.EXE', path, size: 20 }],
    });
    await expect(async () => {
      for await (const chunk of isoStream(layout)) void chunk;
    }).rejects.toThrow(/shrank/);
  });

  it('cannot be built in memory when a file is on disk', () => {
    expect(() =>
      buildIso({ label: 'X', files: [{ name: 'P01.EXE', path: '/nonexistent', size: 1 }] }),
    ).toThrow(/isoStream/);
  });
});

describe('first logon with packages', () => {
  const settings = (packages: unknown[]) =>
    windowsTemplateSchema.parse({
      family: 'WINDOWS',
      isoFilename: 'Win11.iso',
      imageName: 'Windows 11 Pro',
      virtioIsoFilename: 'virtio-win.iso',
      accounts: [{ name: 'beheer', administrator: true }],
      packages,
    });
  const build = (packages: unknown[]) =>
    buildAutounattend({
      settings: settings(packages),
      hostname: 'WS-1',
      macAddress: 'bc:24:11:00:00:01',
      network: { mode: 'DHCP' },
      passwords: { administrator: 'Adm1n-Secret-1', beheer: 'Beheer-Secret-1' },
      productKey: null,
    });

  it('runs the packages script before the auto-logon ends and before the done marker', () => {
    const doc = build([{ packageId: '11111111-1111-4111-8111-111111111111' }]);
    const command = packagesFirstLogonCommand(['D', 'E', 'F', 'G', 'H']);
    const at = doc.indexOf(command.replace(/&/g, '&amp;'));
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(doc.indexOf('AutoAdminLogon'));
    expect(at).toBeLessThan(doc.indexOf(WINDOWS_DONE_MARKER));
  });

  it('runs nothing extra without packages', () => {
    expect(build([])).not.toContain(PACKAGES_SCRIPT);
  });

  it('refuses packages on a template without the guest agent', () => {
    expect(() =>
      windowsTemplateSchema.parse({
        family: 'WINDOWS',
        isoFilename: 'Win11.iso',
        imageName: 'Windows Server 2025 Standard',
        virtio: false,
        guestAgent: false,
        packages: [{ packageId: '11111111-1111-4111-8111-111111111111' }],
      }),
    ).toThrow(/guest agent/);
  });
});

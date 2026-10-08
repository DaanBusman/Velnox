import { PACKAGE_SUCCESS_CODES, type PackageKind, type PackageRunAs } from '@velnox/shared';

/**
 * Installer packages on a CD of their own (Phase 5C).
 *
 * A Windows template can run the tenant's MSIs and EXEs after Setup. They are
 * not put on the answer CD: that one holds the unattend passwords and lives
 * only as long as it must, while a package can be gigabytes. So a second CD
 * carries the packages, each under a short name (`P01.MSI`), one small script
 * per package that runs it and writes its exit code, and `VELNOXPK.CMD`, which
 * runs them in order. One first-logon command finds that script on whichever
 * drive the CD landed and calls it, before the done marker is written.
 *
 * **How a package runs.** `SYSTEM` goes through a one-off scheduled task as
 * Local System — what software deployment tools do — and the script waits for
 * its exit code to appear. `ADMINISTRATOR` runs it in the first logon itself,
 * which is the built-in Administrator's, elevated.
 *
 * **What comes back.** `C:\Windows\Temp\velnox-packages.txt`: one line per
 * package that ran, `NN <exit code>`, then `done`, or `stopped` when a required
 * package failed and the rest were not run. Velnox reads it through the guest
 * agent once the done marker is there. An MSI also leaves a verbose log in
 * `C:\Windows\Temp\velnox-packages\NN.log` for whoever looks inside the VM.
 *
 * **Arguments** are written into the script as the template has them: quotes
 * work, and so does `%ProgramFiles%`. They are the tenant's own command line
 * for its own VM; the validation that matters is that they are one line.
 */

export const PACKAGES_LABEL = 'VELNOXPKG';
export const PACKAGES_SCRIPT = 'VELNOXPK.CMD';
export const PACKAGES_RESULT = 'C:\\Windows\\Temp\\velnox-packages.txt';
const PACKAGES_OUT = 'C:\\Windows\\Temp\\velnox-packages';

export interface PackageToRun {
  /** The name the tenant gave it, for comments and log lines. */
  filename: string;
  kind: PackageKind;
  arguments: string;
  runAs: PackageRunAs;
  required: boolean;
}

/** `01`, `02`: a package's number on the CD and in the results. */
export const packageNumber = (index: number): string => String(index + 1).padStart(2, '0');

/** The name a package has on the CD: 8.3, so both directory trees agree. */
export const packageCdName = (index: number, kind: PackageKind): string =>
  `P${packageNumber(index)}.${kind}`;

/** Windows reads .cmd files line by line, ending in CRLF. */
const crlf = (lines: string[]): Buffer => Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8');

/** One package's own script: run it, wait, keep its exit code. */
export function packageScript(index: number, item: PackageToRun): Buffer {
  const n = packageNumber(index);
  const file = `"%~dp0${packageCdName(index, item.kind)}"`;
  const args = item.arguments.trim();
  const run =
    item.kind === 'MSI'
      ? `start "" /wait msiexec /i ${file} /l*v "${PACKAGES_OUT}\\${n}.log"${args ? ` ${args}` : ''}`
      : `start "" /wait ${file}${args ? ` ${args}` : ''}`;
  return crlf([
    '@echo off',
    `rem Velnox package ${n}: ${item.filename}`,
    run,
    'set "VELNOX_RC=%ERRORLEVEL%"',
    `>"${PACKAGES_OUT}\\${n}.exit" echo %VELNOX_RC%`,
    'exit /b 0',
  ]);
}

/** The script that runs every package in order, and writes how each ended. */
export function packagesScript(items: PackageToRun[]): Buffer {
  const lines = [
    '@echo off',
    'rem Written by Velnox: the installer packages of this VM, run once at first logon.',
    `rem How each one ended goes to ${PACKAGES_RESULT}, which Velnox reads.`,
    'setlocal EnableExtensions',
    'set "VELNOX_CD=%~dp0"',
    `set "VELNOX_OUT=${PACKAGES_OUT}"`,
    `set "VELNOX_RESULT=${PACKAGES_RESULT}"`,
    'if not exist "%VELNOX_OUT%" mkdir "%VELNOX_OUT%"',
    'if exist "%VELNOX_RESULT%" del /q "%VELNOX_RESULT%"',
    '',
  ];
  items.forEach((item, index) => {
    const n = packageNumber(index);
    lines.push(
      `rem ${n}: ${item.filename}, as ${item.runAs === 'SYSTEM' ? 'SYSTEM' : 'Administrator'}${item.required ? ', required' : ''}`,
      `call :${item.runAs === 'SYSTEM' ? 'system' : 'admin'} ${n}`,
      `call :record ${n} ${item.required ? 1 : 0}`,
      'if errorlevel 1 goto stopped',
      '',
    );
  });
  lines.push(
    '>>"%VELNOX_RESULT%" echo done',
    'exit /b 0',
    '',
    ':stopped',
    '>>"%VELNOX_RESULT%" echo stopped',
    'exit /b 0',
    '',
    'rem As Local System, through a one-off scheduled task; wait for its exit code.',
    ':system',
    'if exist "%VELNOX_OUT%\\%1.exit" del /q "%VELNOX_OUT%\\%1.exit"',
    'schtasks /create /tn "Velnox package %1" /ru SYSTEM /rl HIGHEST /sc once /st 00:00 /f /tr "cmd /c \\"%VELNOX_CD%P%1.CMD\\"" >nul 2>&1',
    'if errorlevel 1 (',
    '  >"%VELNOX_OUT%\\%1.exit" echo -2',
    '  exit /b 0',
    ')',
    'schtasks /run /tn "Velnox package %1" >nul 2>&1',
    ':system_wait',
    'if exist "%VELNOX_OUT%\\%1.exit" goto system_done',
    'ping -n 3 127.0.0.1 >nul',
    'goto system_wait',
    ':system_done',
    'schtasks /delete /tn "Velnox package %1" /f >nul 2>&1',
    'exit /b 0',
    '',
    'rem In this logon: the built-in Administrator, elevated.',
    ':admin',
    'if exist "%VELNOX_OUT%\\%1.exit" del /q "%VELNOX_OUT%\\%1.exit"',
    'call "%VELNOX_CD%P%1.CMD"',
    'exit /b 0',
    '',
    'rem Write how a package ended; 1 when a required one failed.',
    ':record',
    'set "VELNOX_CODE="',
    'if exist "%VELNOX_OUT%\\%1.exit" set /p VELNOX_CODE=<"%VELNOX_OUT%\\%1.exit"',
    'if not defined VELNOX_CODE set "VELNOX_CODE=-1"',
    '>>"%VELNOX_RESULT%" echo %1 %VELNOX_CODE%',
    'if "%2"=="0" exit /b 0',
    ...PACKAGE_SUCCESS_CODES.map((code) => `if "%VELNOX_CODE%"=="${code}" exit /b 0`),
    'exit /b 1',
  );
  return crlf(lines);
}

/** The first-logon command: find the packages CD and run its script. */
export function packagesFirstLogonCommand(driveLetters: string[]): string {
  return `cmd /c for %d in (${driveLetters.join(' ')}) do if exist %d:\\${PACKAGES_SCRIPT} call %d:\\${PACKAGES_SCRIPT}`;
}

export interface PackageOutcome {
  index: number;
  exitCode: number;
}

/**
 * The results file, read back. `finished` is false when the file says neither
 * `done` nor `stopped` — the script never got to its end.
 */
export function parsePackageResults(text: string): {
  outcomes: PackageOutcome[];
  finished: boolean;
  stopped: boolean;
} {
  const outcomes: PackageOutcome[] = [];
  let finished = false;
  let stopped = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === 'done') finished = true;
    else if (line === 'stopped') {
      finished = true;
      stopped = true;
    } else {
      const match = /^(\d{2})\s+(-?\d+)$/.exec(line);
      if (match) outcomes.push({ index: Number(match[1]) - 1, exitCode: Number(match[2]) });
    }
  }
  return { outcomes, finished, stopped };
}

/** What an exit code means, for a log line. */
export function describeExitCode(code: number): string {
  if (code === 0) return 'installed';
  if (code === 3010) return 'installed; wants a restart (3010)';
  if (code === 1641) return 'installed; restarted or will restart (1641)';
  if (code === -1) return 'no exit code was recorded';
  if (code === -2) return 'the scheduled task to run it as SYSTEM could not be created';
  if (code === 1603) return 'failed: fatal error during installation (1603)';
  if (code === 1618) return 'failed: another installation was in progress (1618)';
  if (code === 1619) return 'failed: the package could not be opened (1619)';
  if (code === 1639) return 'failed: invalid command line arguments (1639)';
  return `failed with exit code ${code}`;
}

export const packageSucceeded = (code: number): boolean =>
  (PACKAGE_SUCCESS_CODES as readonly number[]).includes(code);

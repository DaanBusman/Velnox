import type { CheckSeverity } from './upgrade';

/**
 * `pve8to9`, read (Phase 9B).
 *
 * The checklist Proxmox ships with PVE 8.4 prints sections (`= TITLE =`),
 * findings (`PASS:`, `INFO:`, `SKIP:`, `NOTICE:`, `WARN:`, `FAIL:`), a
 * finding's further lines unprefixed beneath it, and a summary. The parser is
 * versioned and written against `PVE/CLI/pve8to9.pm` on pve-manager's
 * `stable-8` branch; a line it cannot place is kept verbatim as `UNKNOWN`,
 * which stops an upgrade like a blocker — never assumed harmless.
 *
 * The classifier then gives each finding Velnox's key, severity and, where
 * Velnox can fix it, a remediation.
 */

export const PVE8TO9_PARSER_VERSION = 1;

export type Pve8to9Level = 'PASS' | 'INFO' | 'SKIP' | 'NOTICE' | 'WARN' | 'FAIL';

export interface Pve8to9Line {
  level: Pve8to9Level | 'UNKNOWN';
  section: string | null;
  /** The first line, without its prefix. */
  message: string;
  /** The lines beneath it, as printed. */
  detail: string[];
  /** Every line of it, verbatim. */
  raw: string;
}

export interface Pve8to9Output {
  parserVersion: number;
  lines: Pve8to9Line[];
  summary: {
    total: number;
    passed: number;
    skipped: number;
    warnings: number;
    failures: number;
  } | null;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
const FINDING = /^(PASS|INFO|SKIP|NOTICE|WARN|FAIL): ?(.*)$/;
const HEADER = /^= (.+) =$/;
const SUMMARY = /^(TOTAL|PASSED|SKIPPED|WARNINGS|FAILURES):\s+(\d+)$/;
/** Lines pve8to9 prints without a prefix to say what comes next — the typo is Proxmox's. */
const PROGRESS =
  /^(Checking for package updates\.\.|Checking proxmox-ve package version\.\.|Checking running kernel version\.\.|Analzying quorum settings and state\.\.|Analyzing quorum settings and state\.\.|Checking nodelist entries\.\.|Checking totem settings\.\.)$/;
const TRAILER =
  /^(ATTENTION: Please check the output for detailed information!|Try to solve the problems one at a time and then run this checklist tool again\.)$/;

export function parsePve8to9(output: string): Pve8to9Output {
  const lines: Pve8to9Line[] = [];
  const summary: Record<string, number> = {};
  let section: string | null = null;
  let current: Pve8to9Line | null = null;
  for (const rawLine of output.replace(ANSI, '').split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    // A blank line can sit inside a finding (LVM's advice has one); it ends nothing.
    if (!line.trim()) continue;
    const header = HEADER.exec(line);
    if (header) {
      section = header[1]!;
      current = null;
      continue;
    }
    const total = SUMMARY.exec(line);
    if (total && section === 'SUMMARY') {
      summary[total[1]!.toLowerCase()] = Number(total[2]);
      current = null;
      continue;
    }
    if (TRAILER.test(line)) continue;
    if (PROGRESS.test(line)) {
      current = null;
      continue;
    }
    const finding = FINDING.exec(line);
    if (finding) {
      current = {
        level: finding[1] as Pve8to9Level,
        section,
        message: finding[2]!,
        detail: [],
        raw: line,
      };
      lines.push(current);
      continue;
    }
    if (current && current.level !== 'UNKNOWN') {
      current.detail.push(line.trim());
      current.raw += `\n${line}`;
      continue;
    }
    lines.push({ level: 'UNKNOWN', section, message: line.trim(), detail: [], raw: line });
    current = null;
  }
  return {
    parserVersion: PVE8TO9_PARSER_VERSION,
    lines,
    summary:
      'total' in summary
        ? {
            total: summary.total ?? 0,
            passed: summary.passed ?? 0,
            skipped: summary.skipped ?? 0,
            warnings: summary.warnings ?? 0,
            failures: summary.failures ?? 0,
          }
        : null,
  };
}

export interface ClassifiedFinding {
  key: string;
  severity: CheckSeverity;
  title: string;
  remediationId?: string;
  /** Facts the remediation needs, read from the finding: the microcode package. */
  params?: Record<string, string>;
}

interface Rule {
  match: RegExp;
  key: string;
  /** Velnox's severity, when it differs from what the level says. */
  severity?: CheckSeverity;
  remediationId?: string;
  params?: (m: RegExpExecArray) => Record<string, string>;
}

/**
 * What Velnox knows of pve8to9's findings, by their text in pve8to9.pm. A
 * WARN or FAIL not here keeps its level's severity, under a key made from its
 * text, so it is still shown, counted and compared between runs.
 */
const RULES: Rule[] = [
  {
    match: /^proxmox-ve package is too old, please upgrade to >= (\S+)!/,
    key: 'pve8to9.pve-too-old',
    severity: 'BLOCKER',
    remediationId: 'pve.update-bookworm',
  },
  {
    match: /^updates for the following packages are available:/,
    key: 'pve8to9.updates-pending',
    remediationId: 'pve.update-bookworm',
  },
  {
    match: /^The matching CPU microcode package '((?:amd64|intel)-microcode)' could not be found!/,
    key: 'pve8to9.microcode-missing',
    remediationId: 'pve.microcode',
    params: (m) => ({ package: m[1]! }),
  },
  {
    match: /^Found matching CPU microcode package '(\S+)' installed\./,
    key: 'pve8to9.microcode-missing',
  },
  {
    match: /^Deprecated config '\/etc\/sysctl\.conf' contains settings/,
    key: 'pve8to9.sysctl-conf',
    remediationId: 'pve.sysctl-move',
  },
  {
    match: /^systemd-boot meta-package installed\./,
    key: 'pve8to9.systemd-boot',
    severity: 'BLOCKER',
    remediationId: 'pve.remove-systemd-boot',
  },
  {
    match: /^systemd-boot package installed on legacy-boot system is not necessary/,
    key: 'pve8to9.systemd-boot',
    remediationId: 'pve.remove-systemd-boot',
  },
  {
    match: /^System booted in uefi mode but grub-efi-amd64 meta-package not installed/,
    key: 'pve8to9.grub-efi',
    remediationId: 'pve.install-grub-efi',
  },
  {
    match:
      /^Removable bootloader found at '\/boot\/efi\/EFI\/BOOT\/BOOTX64\.efi', but GRUB packages not set up/,
    key: 'pve8to9.grub-removable',
    remediationId: 'pve.grub-removable',
  },
  { match: /^bootloader packages installed correctly/, key: 'pve8to9.bootloader' },
  {
    match: /^Starting with PVE 9, autoactivation will be disabled/,
    key: 'pve8to9.lvm-autoactivation',
    remediationId: 'pve.lvm-autoactivation',
  },
  {
    match: /^Less than 5 GB free space on root file system/,
    key: 'pve8to9.root-space',
    severity: 'BLOCKER',
  },
  {
    match: /^Less than 10 GB free space on root file system/,
    key: 'pve8to9.root-space',
    severity: 'INFO',
  },
  { match: /^dkms modules found/, key: 'pve8to9.dkms' },
  // Velnox moves a node's guests away before its upgrade, as a rolling update does.
  { match: /^(\d+) running guest\(s\) detected/, key: 'pve8to9.running-guests', severity: 'INFO' },
  { match: /^no running guest detected/, key: 'pve8to9.running-guests' },
  { match: /^(\d+) nodes are offline!/, key: 'pve8to9.nodes-offline', severity: 'BLOCKER' },
  {
    match: /^Hyper-converged Ceph .* is to old for upgrade!/,
    key: 'pve8to9.ceph-too-old',
    severity: 'BLOCKER',
  },
  { match: /^'noout' flag not set/, key: 'pve8to9.ceph-noout', severity: 'INFO' },
  {
    match:
      /^Found at least one CT \((\d+)\) which does not support running in a unified cgroup v2 layout/,
    key: 'pve8to9.cgroup-v1-container',
    severity: 'BLOCKER',
  },
  {
    match: /^System explicitly configured for legacy hybrid cgroup hierarchy/,
    key: 'pve8to9.cgroup-hybrid',
    severity: 'BLOCKER',
  },
  { match: /^found 'glusterfs' storage/, key: 'pve8to9.glusterfs', severity: 'BLOCKER' },
];

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/'[^']*'/g, 'x')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

const LEVEL_SEVERITY: Record<Pve8to9Line['level'], CheckSeverity> = {
  PASS: 'PASS',
  INFO: 'INFO',
  SKIP: 'INFO',
  NOTICE: 'INFO',
  WARN: 'WARNING',
  FAIL: 'BLOCKER',
  UNKNOWN: 'UNKNOWN',
};

/** One parsed line as a check; null for the INFO and SKIP lines that only say what is being checked. */
export function classifyPve8to9(line: Pve8to9Line): ClassifiedFinding | null {
  if (line.level === 'UNKNOWN') {
    return {
      key: `pve8to9.unknown.${slug(line.message)}`,
      severity: 'UNKNOWN',
      title: line.message,
    };
  }
  for (const rule of RULES) {
    const m = rule.match.exec(line.message);
    if (!m) continue;
    // A PASS of a known check passes it; anything else takes Velnox's severity.
    const severity = line.level === 'PASS' ? 'PASS' : (rule.severity ?? LEVEL_SEVERITY[line.level]);
    return {
      key: rule.key,
      severity,
      title: line.message,
      // Remedied when it warns or blocks; a notice — local LVM volumes — is left be.
      ...((severity === 'WARNING' || severity === 'BLOCKER') && rule.remediationId
        ? { remediationId: rule.remediationId }
        : {}),
      ...(rule.params ? { params: rule.params(m) } : {}),
    };
  }
  if (line.level === 'INFO' || line.level === 'SKIP' || line.level === 'PASS') return null;
  return {
    key: `pve8to9.${line.level.toLowerCase()}.${slug(line.message)}`,
    severity: LEVEL_SEVERITY[line.level],
    title: line.message,
  };
}

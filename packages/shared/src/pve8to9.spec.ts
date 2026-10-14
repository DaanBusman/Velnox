import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyPve8to9, parsePve8to9 } from './pve8to9';

/**
 * Golden files: pve8to9's output as pve8to9.pm (pve-manager stable-8) prints
 * it, assembled from that file's own messages, prefixes, progress lines and
 * summary — see testdata/pve8to9/README.md.
 */
const golden = (name: string) =>
  readFileSync(join(__dirname, '..', 'testdata', 'pve8to9', name), 'utf8');

const classified = (name: string) =>
  parsePve8to9(golden(name))
    .lines.map(classifyPve8to9)
    .filter((c): c is NonNullable<typeof c> => c !== null);

describe('parsePve8to9 on 8.4.1 with problems', () => {
  const out = parsePve8to9(golden('8.4.1-problems.txt'));

  it('reads the summary', () => {
    expect(out.summary).toEqual({ total: 31, passed: 21, skipped: 3, warnings: 3, failures: 1 });
  });

  it('places every line: progress lines and blank lines inside a finding are not unknown', () => {
    expect(out.lines.filter((l) => l.level === 'UNKNOWN')).toEqual([]);
  });

  it('keeps a finding’s further lines, and its sections', () => {
    const lvm = out.lines.find((l) => l.message.startsWith('Starting with PVE 9, autoactivation'))!;
    expect(lvm.level).toBe('NOTICE');
    expect(lvm.detail).toContain(
      '/usr/share/pve-manager/migrations/pve-lvm-disable-autoactivation',
    );
    expect(lvm.section).toBe('MISCELLANEOUS CHECKS');
    const microcode = out.lines.find((l) => l.message.startsWith('The matching CPU microcode'))!;
    expect(microcode.detail).toEqual([
      "Ensure you enable the 'non-free-firmware' component in the apt sources and run:",
      'apt install intel-microcode',
    ]);
  });

  it('classifies what Velnox can fix, and how', () => {
    const findings = classified('8.4.1-problems.txt').filter(
      (c) => c.severity !== 'PASS' && c.severity !== 'INFO',
    );
    expect(findings.map((f) => [f.key, f.severity, f.remediationId ?? null])).toEqual([
      ['pve8to9.updates-pending', 'WARNING', 'pve.update-bookworm'],
      ['pve8to9.systemd-boot', 'BLOCKER', 'pve.remove-systemd-boot'],
      ['pve8to9.sysctl-conf', 'WARNING', 'pve.sysctl-move'],
      ['pve8to9.microcode-missing', 'WARNING', 'pve.microcode'],
    ]);
    expect(findings.find((f) => f.key === 'pve8to9.microcode-missing')?.params).toEqual({
      package: 'intel-microcode',
    });
  });
});

describe('parsePve8to9 on a clean 8.4.14 with Ceph Squid', () => {
  it('keeps a line it cannot place, verbatim, as UNKNOWN — which stops an upgrade', () => {
    const out = parsePve8to9(golden('8.4.14-clean-ceph.txt'));
    const unknown = out.lines.filter((l) => l.level === 'UNKNOWN');
    expect(unknown.map((l) => l.raw)).toEqual([
      'A line from a newer pve8to9 that this parser has never seen',
    ]);
    const c = classifyPve8to9(unknown[0]!)!;
    expect(c.severity).toBe('UNKNOWN');
  });

  it('passes a known check under the key its failure has, so a fix is a comparison', () => {
    const c = classified('8.4.14-clean-ceph.txt');
    expect(c.find((f) => f.key === 'pve8to9.microcode-missing')?.severity).toBe('PASS');
    expect(c.find((f) => f.key === 'pve8to9.ceph-noout')?.severity).toBe('INFO');
  });
});

describe('parsePve8to9 after the upgrade', () => {
  it('reads PVE 9 and nothing open', () => {
    const out = parsePve8to9(golden('9.0.10-after.txt'));
    expect(out.summary?.failures).toBe(0);
    expect(out.lines.some((l) => l.message === 'already upgraded to Proxmox VE 9')).toBe(true);
    expect(
      classified('9.0.10-after.txt').filter((c) => c.severity !== 'PASS' && c.severity !== 'INFO'),
    ).toEqual([]);
  });

  it('blocks on a container that needs cgroup v1, and not on the note that the check was skipped', () => {
    const out = parsePve8to9(
      [
        "SKIP: NOTE: Expensive checks, like CT cgroupv2 compat, not performed without '--full' parameter",
        'FAIL: Found at least one CT (105) which does not support running in a unified cgroup v2 layout',
        '    You must upgrade the Containers distros! Skipping further CT compat checks.',
      ].join('\n'),
    );
    expect(out.lines.map(classifyPve8to9)).toEqual([
      null,
      expect.objectContaining({ key: 'pve8to9.cgroup-v1-container', severity: 'BLOCKER' }),
    ]);
  });

  it('strips colour', () => {
    const out = parsePve8to9('\u001b[1;31mFAIL: 2 nodes are offline!\u001b[0m\n');
    expect(classifyPve8to9(out.lines[0]!)).toMatchObject({
      key: 'pve8to9.nodes-offline',
      severity: 'BLOCKER',
    });
  });
});

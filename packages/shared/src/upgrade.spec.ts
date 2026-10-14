import { describe, expect, it } from 'vitest';
import {
  SELFTEST_CEPH_PLAYBOOK,
  SELFTEST_NODE_PLAYBOOK,
  buildUpgradeReport,
  changeSetRecord,
  compareRuns,
  compositeNext,
  evaluateGuard,
  fileDiff,
  playbookProblems,
  reportMarkdown,
  routeRemediation,
  type UpgradeReportInput,
} from './upgrade';

describe('evaluateGuard', () => {
  const facts = {
    cluster: { quorate: true, offline: 0 },
    target: { version: '8.4.1' },
    ceph: { health: 'HEALTH_WARN' },
  };

  it('holds, and says exactly what does not', () => {
    expect(evaluateGuard({ fact: 'cluster.quorate', op: 'eq', value: true }, facts).ok).toBe(true);
    const r = evaluateGuard(
      {
        all: [
          { fact: 'ceph.health', op: 'in', value: ['HEALTH_OK'] },
          { fact: 'target.version', op: 'versionGte', value: '8.4.1' },
        ],
      },
      facts,
    );
    expect(r.ok).toBe(false);
    expect(r.failed).toEqual(['ceph.health in ["HEALTH_OK"] (is "HEALTH_WARN")']);
  });

  it('compares versions as versions, and treats a missing fact as not holding', () => {
    expect(
      evaluateGuard({ fact: 'target.version', op: 'versionLt', value: '8.10' }, facts).ok,
    ).toBe(true);
    expect(evaluateGuard({ fact: 'nowhere.at.all', op: 'exists' }, facts).ok).toBe(false);
    expect(evaluateGuard({ fact: 'nowhere', op: 'gte', value: 1 }, facts).ok).toBe(false);
  });

  it('combines with any and not', () => {
    expect(
      evaluateGuard(
        {
          any: [
            { fact: 'ceph.health', op: 'eq', value: 'HEALTH_OK' },
            { not: { fact: 'cluster.offline', op: 'gte', value: 1 } },
          ],
        },
        facts,
      ).ok,
    ).toBe(true);
  });
});

describe('playbooks as data', () => {
  it('the self-test playbooks are well formed', () => {
    expect(playbookProblems(SELFTEST_NODE_PLAYBOOK)).toEqual([]);
    expect(playbookProblems(SELFTEST_CEPH_PLAYBOOK)).toEqual([]);
  });

  it('finds a repeated step, a phase out of order and an unknown action', () => {
    const bad = {
      ...SELFTEST_NODE_PLAYBOOK,
      steps: [
        { key: 'a', phase: 'upgrade' as const, action: 'x' },
        { key: 'a', phase: 'preflight' as const, action: 'y' },
      ],
    };
    const problems = playbookProblems(bad, new Set(['x']));
    expect(problems).toContain('step "a" appears twice');
    expect(problems).toContain('step "a" is in preflight, after a later phase');
    expect(problems).toContain('step "a" names action "y", which does not exist');
  });
});

describe('remediations', () => {
  it('only low risk that can be undone runs by itself', () => {
    expect(routeRemediation({ risk: 'LOW', reversible: true })).toBe('AUTOMATIC');
    expect(routeRemediation({ risk: 'LOW', reversible: false })).toBe('APPROVED');
    expect(routeRemediation({ risk: 'MEDIUM', reversible: true })).toBe('APPROVED');
    expect(routeRemediation({ risk: 'HIGH', reversible: true })).toBe('APPROVED');
  });

  it('shows the exact change, file by file', () => {
    const diff = fileDiff({ path: '/etc/x.conf', before: 'a\nmode=old', after: 'a\nmode=new' });
    expect(diff).toBe('--- /etc/x.conf\n+++ /etc/x.conf\n  a\n- mode=old\n+ mode=new');
    const record = changeSetRecord([
      {
        label: 'pve1',
        change: {
          summary: 'switch mode',
          files: [{ path: '/etc/x.conf', before: 'mode=old', after: 'mode=new' }],
          commands: [],
          packages: { install: ['intel-microcode'], remove: [] },
        },
      },
    ]);
    expect(record).toMatchObject({
      change1: 'pve1: switch mode',
      change1Install: 'intel-microcode',
    });
    expect(record.change1Diff).toContain('+ mode=new');
  });
});

describe('compareRuns', () => {
  it('sees what a remediation fixed, what is left, and what is new', () => {
    expect(
      compareRuns(
        [
          { key: 'a', severity: 'WARNING' },
          { key: 'b', severity: 'BLOCKER' },
          { key: 'c', severity: 'PASS' },
        ],
        [
          { key: 'a', severity: 'PASS' },
          { key: 'b', severity: 'BLOCKER' },
          { key: 'c', severity: 'UNKNOWN' },
        ],
      ),
    ).toEqual({ fixed: ['a'], remaining: ['b'], appeared: ['c'] });
  });
});

describe('compositeNext', () => {
  it('starts children in order, waits, and stops on a failure without starting the rest', () => {
    expect(
      compositeNext([
        { id: '1', status: 'DRAFT' },
        { id: '2', status: 'DRAFT' },
      ]),
    ).toEqual({ action: 'start', childId: '1' });
    expect(
      compositeNext([
        { id: '1', status: 'RUNNING' },
        { id: '2', status: 'DRAFT' },
      ]),
    ).toEqual({ action: 'wait' });
    expect(
      compositeNext([
        { id: '1', status: 'COMPLETED' },
        { id: '2', status: 'DRAFT' },
      ]),
    ).toEqual({ action: 'start', childId: '2' });
    expect(
      compositeNext([
        { id: '1', status: 'FAILED' },
        { id: '2', status: 'DRAFT' },
      ]),
    ).toEqual({ action: 'stop', failedId: '1' });
    expect(
      compositeNext([
        { id: '1', status: 'COMPLETED' },
        { id: '2', status: 'COMPLETED' },
      ]),
    ).toEqual({ action: 'done' });
  });
});

describe('reports', () => {
  const base = (kind: 'NODE' | 'CEPH_DAEMON'): UpgradeReportInput => ({
    plan: {
      id: 'p',
      name: 'Self-test',
      kind: 'SELFTEST',
      playbookId: 'velnox.selftest-nodes',
      playbookVersion: 1,
      status: 'COMPLETED',
      clusterName: 'fixture',
      startedAt: '2026-10-11T10:00:00.000Z',
      finishedAt: '2026-10-11T10:05:00.000Z',
    },
    targets: [
      {
        id: 't1',
        kind,
        label: kind === 'NODE' ? 'pve1' : 'osd.0',
        group: kind === 'NODE' ? null : 'OSD',
        status: 'DONE',
        preState: { version: '1' },
        postState: { version: '2' },
      },
    ],
    checks: [
      {
        targetId: 't1',
        runIndex: 0,
        key: 'selftest.marker-missing',
        severity: 'WARNING',
        title: 'm',
      },
      { targetId: 't1', runIndex: 1, key: 'selftest.marker-missing', severity: 'PASS', title: 'm' },
    ],
    remediations: [
      {
        targetId: 't1',
        remediationId: 'selftest.marker',
        mode: 'AUTOMATIC',
        risk: 'LOW',
        status: 'VALIDATED',
        summary: 'write the marker',
      },
    ],
  });

  it('reports a node-by-node run, with before and after', () => {
    const report = buildUpgradeReport(base('NODE'));
    expect(report.verdict).toBe('COMPLETED');
    expect(report.targets[0]).toMatchObject({
      label: 'pve1',
      before: 'version 1',
      after: 'version 2',
      fixed: ['selftest.marker-missing'],
      remaining: [],
    });
    const md = reportMarkdown(report);
    expect(md).toContain('| Node | Result | Before | After |');
    expect(md).toContain('| pve1 | DONE | version 1 | version 2 | selftest.marker-missing | — |');
  });

  it('shows a target’s version first, whatever order its state was stored in', () => {
    const input = base('NODE');
    input.targets[0] = {
      ...input.targets[0]!,
      preState: { kernel: '6.8.12-4-pve', version: '8.4.1' },
      postState: { kernel: '6.14.11-2-pve', version: '9.0.10' },
    };
    expect(buildUpgradeReport(input).targets[0]).toMatchObject({
      before: 'version 8.4.1, kernel 6.8.12-4-pve',
      after: 'version 9.0.10, kernel 6.14.11-2-pve',
    });
  });

  it('reports a daemon-by-daemon run the same way, and a composite with its children', () => {
    const daemon = base('CEPH_DAEMON');
    const md = reportMarkdown(buildUpgradeReport(daemon));
    expect(md).toContain('| Daemon |');
    expect(md).toContain('| osd.0 (OSD) |');
    const composite = buildUpgradeReport({
      ...daemon,
      plan: {
        ...daemon.plan,
        kind: 'COMPOSITE',
        playbookId: null,
        playbookVersion: null,
        status: 'FAILED',
      },
      targets: [],
      checks: [],
      remediations: [],
      children: [base('CEPH_DAEMON'), base('NODE')],
    });
    expect(composite.verdict).toBe('FAILED');
    expect(reportMarkdown(composite)).toContain('## Self-test on fixture');
  });
});

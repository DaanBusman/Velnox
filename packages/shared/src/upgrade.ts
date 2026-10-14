import { z } from 'zod';
import { CEPH_MAJOR_PLAYBOOK } from './ceph';
import { PVE_MAJOR_PLAYBOOK, PVE_REMEDIATIONS } from './pve-major';
import { compareVersions } from './updates';

/**
 * The major upgrade framework (Phase 8): playbooks as data, the guards that
 * decide whether a step may run, how a remediation is routed, composite plans,
 * and the report. Pure — the worker executes, the API plans, and both read the
 * same definitions.
 *
 * A playbook names its steps' actions; the worker holds the code for each
 * action, check provider and remediation, by name. Phases 9A (Ceph) and 9B
 * (PVE 8 → 9) are two more playbooks on this engine; the self-test playbooks
 * here prove the engine on its own, against Velnox's own state only.
 */

export const UPGRADE_PHASES = [
  'discovery',
  'preflight',
  'remediation',
  'recheck',
  'upgrade',
  'validation',
  'report',
] as const;
export type UpgradePhase = (typeof UPGRADE_PHASES)[number];

export const CHECK_SEVERITIES = ['PASS', 'INFO', 'WARNING', 'BLOCKER', 'UNKNOWN'] as const;
export type CheckSeverity = (typeof CHECK_SEVERITIES)[number];
/** Severities that stop an upgrade. An unknown line is never assumed harmless. */
export const STOPPING_SEVERITIES: readonly CheckSeverity[] = ['BLOCKER', 'UNKNOWN'];

export const UPGRADE_PLAN_KINDS = ['PVE_MAJOR', 'CEPH', 'COMPOSITE', 'SELFTEST'] as const;
export type UpgradePlanKind = (typeof UPGRADE_PLAN_KINDS)[number];

export const UPGRADE_TARGET_KINDS = ['NODE', 'CEPH_DAEMON'] as const;
export type UpgradeTargetKind = (typeof UPGRADE_TARGET_KINDS)[number];

export const UPGRADE_PLAN_STATUSES = [
  'DRAFT',
  'RUNNING',
  'WAITING_APPROVAL',
  'BLOCKED',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;
export type UpgradePlanStatus = (typeof UPGRADE_PLAN_STATUSES)[number];

export const REMEDIATION_RISKS = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type RemediationRisk = (typeof REMEDIATION_RISKS)[number];
export type RemediationMode = 'AUTOMATIC' | 'APPROVED';

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * A condition over facts, as data. `fact` is a dotted path into the facts the
 * engine has collected: `cluster.quorate`, `target.version`, `ceph.health`.
 */
export type Guard =
  | { fact: string; op: 'eq' | 'ne'; value: string | number | boolean | null }
  | { fact: string; op: 'in' | 'notIn'; value: (string | number)[] }
  | { fact: string; op: 'gte' | 'lte'; value: number }
  | { fact: string; op: 'versionGte' | 'versionLt'; value: string }
  | { fact: string; op: 'exists' }
  | { all: Guard[] }
  | { any: Guard[] }
  | { not: Guard };

export type Facts = Record<string, unknown>;

export function factAt(facts: Facts, path: string): unknown {
  let value: unknown = facts;
  for (const part of path.split('.')) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

const show = (v: unknown) => (v === undefined ? 'nothing' : JSON.stringify(v));

/** Whether a guard holds, and — when it does not — every condition that failed, readably. */
export function evaluateGuard(guard: Guard, facts: Facts): { ok: boolean; failed: string[] } {
  if ('all' in guard) {
    const results = guard.all.map((g) => evaluateGuard(g, facts));
    return { ok: results.every((r) => r.ok), failed: results.flatMap((r) => r.failed) };
  }
  if ('any' in guard) {
    const results = guard.any.map((g) => evaluateGuard(g, facts));
    const ok = results.some((r) => r.ok);
    return { ok, failed: ok ? [] : [`none of: ${results.flatMap((r) => r.failed).join('; ')}`] };
  }
  if ('not' in guard) {
    const inner = evaluateGuard(guard.not, facts);
    return { ok: !inner.ok, failed: inner.ok ? [`not expected: ${describeGuard(guard.not)}`] : [] };
  }
  const actual = factAt(facts, guard.fact);
  let ok: boolean;
  switch (guard.op) {
    case 'eq':
      ok = actual === guard.value;
      break;
    case 'ne':
      ok = actual !== guard.value;
      break;
    case 'in':
      ok = (guard.value as unknown[]).includes(actual);
      break;
    case 'notIn':
      ok = !(guard.value as unknown[]).includes(actual);
      break;
    case 'gte':
      ok = typeof actual === 'number' && actual >= guard.value;
      break;
    case 'lte':
      ok = typeof actual === 'number' && actual <= guard.value;
      break;
    case 'versionGte':
      ok = typeof actual === 'string' && compareVersions(actual, guard.value) >= 0;
      break;
    case 'versionLt':
      ok = typeof actual === 'string' && compareVersions(actual, guard.value) < 0;
      break;
    case 'exists':
      ok = actual !== undefined && actual !== null;
      break;
  }
  return { ok, failed: ok ? [] : [`${describeGuard(guard)} (is ${show(actual)})`] };
}

export function describeGuard(guard: Guard): string {
  if ('all' in guard) return guard.all.map(describeGuard).join(' and ');
  if ('any' in guard) return `(${guard.any.map(describeGuard).join(' or ')})`;
  if ('not' in guard) return `not ${describeGuard(guard.not)}`;
  const op: Record<string, string> = {
    eq: '=',
    ne: '≠',
    in: 'in',
    notIn: 'not in',
    gte: '≥',
    lte: '≤',
    versionGte: 'at version ≥',
    versionLt: 'at version <',
  };
  if (guard.op === 'exists') return `${guard.fact} is known`;
  return `${guard.fact} ${op[guard.op]} ${show(guard.value)}`;
}

// ---------------------------------------------------------------------------
// Playbooks as data
// ---------------------------------------------------------------------------

export interface PlaybookStepDef {
  key: string;
  phase: UpgradePhase;
  /** The worker's action by name: `facts.collect`, `checks.run`, `selftest.upgrade`… */
  action: string;
  /** Once per target, in the plan's target order, rather than once for the plan. */
  perTarget?: boolean;
  /** Plain values handed to the action. */
  params?: Record<string, string | number | boolean>;
  /** Must hold for the step to run. */
  guard?: Guard;
  /** A guard that does not hold: `block` fails the run, `skip` passes over the step. */
  onGuardFail?: 'block' | 'skip';
}

export interface UpgradePlaybookDef {
  id: string;
  version: number;
  title: string;
  kind: Exclude<UpgradePlanKind, 'COMPOSITE'>;
  targetKind: UpgradeTargetKind;
  /** Self-test playbooks: offered to those who manage the installation only. */
  internal: boolean;
  /** The check providers `checks.run` uses, by name. */
  checkProviders: string[];
  /**
   * An action run when the run fails, is cancelled, or its worker died — to
   * undo what must not be left behind, such as Ceph's noout flag.
   */
  cleanup?: string;
  steps: PlaybookStepDef[];
}

/** What is wrong with a playbook definition, or an empty list. */
export function playbookProblems(
  def: UpgradePlaybookDef,
  knownActions?: ReadonlySet<string>,
): string[] {
  const problems: string[] = [];
  const keys = new Set<string>();
  let lastPhase = -1;
  for (const step of def.steps) {
    if (keys.has(step.key)) problems.push(`step "${step.key}" appears twice`);
    keys.add(step.key);
    if (!/^[a-z][a-z0-9-]*$/.test(step.key))
      problems.push(`step key "${step.key}" is not a plain key`);
    const phase = UPGRADE_PHASES.indexOf(step.phase);
    if (phase < 0) problems.push(`step "${step.key}" has no known phase`);
    else if (phase < lastPhase)
      problems.push(`step "${step.key}" is in ${step.phase}, after a later phase`);
    lastPhase = Math.max(lastPhase, phase);
    if (knownActions && !knownActions.has(step.action))
      problems.push(`step "${step.key}" names action "${step.action}", which does not exist`);
  }
  if (!def.steps.length) problems.push('a playbook needs steps');
  return problems;
}

// ---------------------------------------------------------------------------
// Remediations
// ---------------------------------------------------------------------------

export interface RemediationDef {
  id: string;
  title: string;
  risk: RemediationRisk;
  /** Velnox can put it back as it was. */
  reversible: boolean;
  /** The check keys it fixes. */
  fixes: string[];
}

/**
 * Automatic only when the risk is low and Velnox can undo it. Anything else
 * waits for a person, who sees the exact change first.
 */
export function routeRemediation(
  def: Pick<RemediationDef, 'risk' | 'reversible'>,
): RemediationMode {
  return def.risk === 'LOW' && def.reversible ? 'AUTOMATIC' : 'APPROVED';
}

/** The exact change a remediation would make — what is approved is what runs. */
export interface ChangeSet {
  summary: string;
  files: { path: string; before: string | null; after: string | null }[];
  commands: string[];
  packages: { install: string[]; remove: string[] };
}

/** A unified-style diff of one file in a change set, for the approval screen and the report. */
export function fileDiff(file: ChangeSet['files'][number]): string {
  const before = file.before === null ? [] : file.before.split('\n');
  const after = file.after === null ? [] : file.after.split('\n');
  const lines = [
    `--- ${file.before === null ? '/dev/null' : file.path}`,
    `+++ ${file.after === null ? '/dev/null' : file.path}`,
  ];
  const common = new Set(before.filter((l) => after.includes(l)));
  for (const l of before) lines.push(common.has(l) ? `  ${l}` : `- ${l}`);
  for (const l of after) if (!common.has(l)) lines.push(`+ ${l}`);
  return lines.join('\n');
}

/** A change set as the flat record an approval carries. */
export function changeSetRecord(
  sets: { label: string; change: ChangeSet }[],
): Record<string, string> {
  const out: Record<string, string> = {};
  sets.forEach(({ label, change }, i) => {
    const n = i + 1;
    out[`change${n}`] = `${label}: ${change.summary}`;
    if (change.files.length) out[`change${n}Diff`] = change.files.map(fileDiff).join('\n');
    if (change.commands.length) out[`change${n}Commands`] = change.commands.join('\n');
    if (change.packages.install.length)
      out[`change${n}Install`] = change.packages.install.join(' ');
    if (change.packages.remove.length) out[`change${n}Remove`] = change.packages.remove.join(' ');
  });
  return out;
}

// ---------------------------------------------------------------------------
// Checks, runs and the comparison between them
// ---------------------------------------------------------------------------

export interface CheckResult {
  key: string;
  severity: CheckSeverity;
  title: string;
  detail?: string;
  /** The line as the tool printed it, kept verbatim. */
  rawLine?: string;
  /** The remediation that fixes it, by id. */
  remediationId?: string;
}

/** What changed between two runs of the same checks on the same target. */
export function compareRuns(
  before: readonly Pick<CheckResult, 'key' | 'severity'>[],
  after: readonly Pick<CheckResult, 'key' | 'severity'>[],
): { fixed: string[]; remaining: string[]; appeared: string[] } {
  const bad = (list: readonly Pick<CheckResult, 'key' | 'severity'>[]) =>
    new Set(list.filter((c) => c.severity !== 'PASS' && c.severity !== 'INFO').map((c) => c.key));
  const was = bad(before);
  const is = bad(after);
  return {
    fixed: [...was].filter((k) => !is.has(k)),
    remaining: [...is].filter((k) => was.has(k)),
    appeared: [...is].filter((k) => !was.has(k)),
  };
}

// ---------------------------------------------------------------------------
// Composite plans
// ---------------------------------------------------------------------------

/**
 * What a composite plan does next, from its children in order: start the next
 * one, stop because one failed (the rest are cancelled, never started), or
 * finish.
 */
export function compositeNext(
  children: readonly { id: string; status: UpgradePlanStatus }[],
):
  | { action: 'start'; childId: string }
  | { action: 'wait' }
  | { action: 'stop'; failedId: string }
  | { action: 'done' } {
  for (const child of children) {
    if (child.status === 'COMPLETED') continue;
    if (child.status === 'FAILED' || child.status === 'CANCELLED' || child.status === 'BLOCKED')
      return { action: 'stop', failedId: child.id };
    if (child.status === 'DRAFT') return { action: 'start', childId: child.id };
    return { action: 'wait' };
  }
  return { action: 'done' };
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export interface UpgradeReportInput {
  plan: {
    id: string;
    name: string;
    kind: UpgradePlanKind;
    playbookId: string | null;
    playbookVersion: number | null;
    status: UpgradePlanStatus;
    clusterName: string;
    startedAt: string | null;
    finishedAt: string | null;
  };
  targets: {
    id: string;
    kind: UpgradeTargetKind;
    label: string;
    group: string | null;
    status: string;
    preState: Record<string, unknown> | null;
    postState: Record<string, unknown> | null;
  }[];
  checks: (CheckResult & { targetId: string | null; runIndex: number })[];
  remediations: {
    targetId: string | null;
    remediationId: string;
    mode: RemediationMode;
    risk: RemediationRisk;
    status: string;
    summary: string;
  }[];
  children?: UpgradeReportInput[];
}

export interface UpgradeReport {
  title: string;
  verdict: 'COMPLETED' | 'FAILED' | 'BLOCKED' | 'INCOMPLETE';
  plan: UpgradeReportInput['plan'];
  targets: {
    label: string;
    kind: UpgradeTargetKind;
    group: string | null;
    status: string;
    before: string;
    after: string;
    firstRun: Record<CheckSeverity, number>;
    lastRun: Record<CheckSeverity, number>;
    fixed: string[];
    remaining: string[];
    remediations: string[];
  }[];
  planChecks: { key: string; severity: CheckSeverity; title: string }[];
  children: UpgradeReport[];
}

const counts = (list: readonly { severity: CheckSeverity }[]) =>
  Object.fromEntries(
    CHECK_SEVERITIES.map((s) => [s, list.filter((c) => c.severity === s).length]),
  ) as Record<CheckSeverity, number>;

/**
 * A target's state, its version first and the rest by name — not in the
 * order the database keeps the keys, which for jsonb is not the order written.
 */
const state = (s: Record<string, unknown> | null) =>
  s && Object.keys(s).length
    ? Object.entries(s)
        .sort(([a], [b]) => (a === 'version' ? -1 : b === 'version' ? 1 : a.localeCompare(b)))
        .map(([k, v]) => `${k} ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
        .join(', ')
    : '—';

/** The report of a run, for a node-by-node or a daemon-by-daemon plan alike. */
export function buildUpgradeReport(input: UpgradeReportInput): UpgradeReport {
  const lastIndex = Math.max(0, ...input.checks.map((c) => c.runIndex));
  const targets = input.targets.map((t) => {
    const own = input.checks.filter((c) => c.targetId === t.id);
    const first = own.filter((c) => c.runIndex === 0);
    const last = own.filter((c) => c.runIndex === Math.max(0, ...own.map((c) => c.runIndex)));
    const cmp = compareRuns(first, last);
    return {
      label: t.label,
      kind: t.kind,
      group: t.group,
      status: t.status,
      before: state(t.preState),
      after: state(t.postState),
      firstRun: counts(first),
      lastRun: counts(last),
      fixed: cmp.fixed,
      remaining: [...cmp.remaining, ...cmp.appeared],
      remediations: input.remediations
        .filter((r) => r.targetId === t.id)
        .map(
          (r) =>
            `${r.remediationId} (${r.mode.toLowerCase()}, ${r.status.toLowerCase()}): ${r.summary}`,
        ),
    };
  });
  const status = input.plan.status;
  const verdict: UpgradeReport['verdict'] =
    status === 'COMPLETED'
      ? 'COMPLETED'
      : status === 'FAILED'
        ? 'FAILED'
        : status === 'BLOCKED'
          ? 'BLOCKED'
          : 'INCOMPLETE';
  return {
    title: `${input.plan.name} on ${input.plan.clusterName}`,
    verdict,
    plan: input.plan,
    targets,
    planChecks: input.checks
      .filter((c) => c.targetId === null && c.runIndex === lastIndex)
      .map((c) => ({ key: c.key, severity: c.severity, title: c.title })),
    children: (input.children ?? []).map(buildUpgradeReport),
  };
}

/** The report as Markdown, to download or attach to a ticket. */
export function reportMarkdown(report: UpgradeReport, depth = 1): string {
  const h = '#'.repeat(depth);
  const lines = [
    `${h} ${report.title}`,
    '',
    `**Result:** ${report.verdict} · **Playbook:** ${report.plan.playbookId ?? 'composite'}${report.plan.playbookVersion ? ` v${report.plan.playbookVersion}` : ''} · **Started:** ${report.plan.startedAt ?? '—'} · **Finished:** ${report.plan.finishedAt ?? '—'}`,
    '',
  ];
  if (report.targets.length) {
    const kind = report.targets[0]!.kind === 'NODE' ? 'Node' : 'Daemon';
    lines.push(
      `| ${kind} | Result | Before | After | Fixed | Still open |`,
      '|---|---|---|---|---|---|',
    );
    for (const t of report.targets) {
      lines.push(
        `| ${t.label}${t.group ? ` (${t.group})` : ''} | ${t.status} | ${t.before} | ${t.after} | ${t.fixed.join(', ') || '—'} | ${t.remaining.join(', ') || '—'} |`,
      );
    }
    lines.push('');
    const rem = report.targets.flatMap((t) => t.remediations.map((r) => `- ${t.label}: ${r}`));
    if (rem.length) lines.push(`${h}# Remediations`, '', ...rem, '');
  }
  if (report.planChecks.length) {
    lines.push(`${h}# Checks for the whole plan`, '');
    for (const c of report.planChecks) lines.push(`- ${c.severity}: ${c.title}`);
    lines.push('');
  }
  for (const child of report.children) lines.push(reportMarkdown(child, depth + 1));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The self-test playbooks
// ---------------------------------------------------------------------------

/**
 * Two playbooks that prove the engine on its own, changing nothing outside
 * Velnox: one node by node, one Ceph daemon by Ceph daemon. Their checks and
 * remediations work on a self-test record kept in the plan; their "upgrade"
 * records each target's state before and after. The options make a check
 * fail, a remediation need approval, or a step fail, on purpose.
 */
const selftestSteps = (unit: string): PlaybookStepDef[] => [
  { key: 'facts', phase: 'discovery', action: 'facts.collect' },
  {
    key: 'cluster-whole',
    phase: 'preflight',
    action: 'guard.only',
    guard: {
      all: [
        { fact: 'cluster.quorate', op: 'eq', value: true },
        { fact: 'cluster.offline', op: 'eq', value: 0 },
      ],
    },
    onGuardFail: 'block',
  },
  { key: 'checks', phase: 'preflight', action: 'checks.run' },
  { key: 'remediate-auto', phase: 'remediation', action: 'remediate.automatic' },
  { key: 'remediate-approve', phase: 'remediation', action: 'remediate.approval' },
  { key: 'remediate-approved', phase: 'remediation', action: 'remediate.approved' },
  { key: 'recheck', phase: 'recheck', action: 'checks.run', params: { recheck: true } },
  { key: 'gate', phase: 'recheck', action: 'checks.gate' },
  { key: unit, phase: 'upgrade', action: 'selftest.upgrade', perTarget: true },
  { key: `${unit}-validate`, phase: 'validation', action: 'selftest.validate', perTarget: true },
  { key: 'report', phase: 'report', action: 'report.build' },
];

export const SELFTEST_NODE_PLAYBOOK: UpgradePlaybookDef = {
  id: 'velnox.selftest-nodes',
  version: 1,
  title: 'Self-test of the upgrade engine, node by node',
  kind: 'SELFTEST',
  targetKind: 'NODE',
  internal: true,
  checkProviders: ['selftest.marker', 'selftest.config'],
  steps: selftestSteps('node'),
};

export const SELFTEST_CEPH_PLAYBOOK: UpgradePlaybookDef = {
  id: 'velnox.selftest-ceph',
  version: 1,
  title: 'Self-test of the upgrade engine, Ceph daemon by daemon',
  kind: 'SELFTEST',
  targetKind: 'CEPH_DAEMON',
  internal: true,
  checkProviders: ['selftest.marker', 'selftest.config'],
  steps: selftestSteps('daemon'),
};

/** The self-test's remediations: one Velnox may apply by itself, one it may not. */
export const SELFTEST_REMEDIATIONS: RemediationDef[] = [
  {
    id: 'selftest.marker',
    title: 'Write the self-test marker',
    risk: 'LOW',
    reversible: true,
    fixes: ['selftest.marker-missing'],
  },
  {
    id: 'selftest.config',
    title: 'Change the self-test configuration',
    risk: 'HIGH',
    reversible: false,
    fixes: ['selftest.config-old'],
  },
];

/** Every playbook, by id. */
export const UPGRADE_PLAYBOOKS: Record<string, UpgradePlaybookDef> = {
  [SELFTEST_NODE_PLAYBOOK.id]: SELFTEST_NODE_PLAYBOOK,
  [SELFTEST_CEPH_PLAYBOOK.id]: SELFTEST_CEPH_PLAYBOOK,
  [CEPH_MAJOR_PLAYBOOK.id]: CEPH_MAJOR_PLAYBOOK,
  [PVE_MAJOR_PLAYBOOK.id]: PVE_MAJOR_PLAYBOOK,
};

export const UPGRADE_REMEDIATIONS: Record<string, RemediationDef> = Object.fromEntries(
  [...SELFTEST_REMEDIATIONS, ...PVE_REMEDIATIONS].map((r) => [r.id, r]),
);

// ---------------------------------------------------------------------------
// Requests and what the screen reads
// ---------------------------------------------------------------------------

export const selftestOptionsSchema = z
  .object({
    /** Leave the marker missing, so the automatic remediation has work. */
    markerMissing: z.boolean().default(true),
    /** Leave the configuration old, so a remediation needs approval. */
    configOld: z.boolean().default(false),
    /** A blocker no remediation fixes. */
    unfixable: z.boolean().default(false),
    /** Fail the upgrade of this target (by label). */
    failTarget: z.string().max(100).nullable().default(null),
  })
  .strict();
export type SelftestOptions = z.infer<typeof selftestOptionsSchema>;

export const createUpgradePlanSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('PLAYBOOK'),
      clusterId: z.string().uuid(),
      name: z.string().trim().min(1).max(120),
      playbookId: z.string().min(1).max(100),
      options: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
  z
    .object({
      kind: z.literal('COMPOSITE'),
      clusterId: z.string().uuid(),
      name: z.string().trim().min(1).max(120),
      children: z
        .array(
          z
            .object({
              name: z.string().trim().min(1).max(120),
              playbookId: z.string().min(1).max(100),
              options: z.record(z.string(), z.unknown()).default({}),
            })
            .strict(),
        )
        .min(2)
        .max(5),
    })
    .strict(),
]);
export type CreateUpgradePlanInput = z.infer<typeof createUpgradePlanSchema>;

/** What an upgrade.run job carries: enough to build its steps without a query. */
export interface UpgradeJobParams {
  planId: string;
  clusterId: string;
  playbookId: string;
  playbookVersion: number;
  targets: { id: string; label: string }[];
}

export interface UpgradePlanSummary {
  id: string;
  name: string;
  kind: UpgradePlanKind;
  status: UpgradePlanStatus;
  clusterId: string;
  clusterName: string;
  playbookId: string | null;
  playbookTitle: string | null;
  parentPlanId: string | null;
  jobId: string | null;
  /** The job's own status: shows a plan waiting for approval. */
  jobStatus: string | null;
  targets: number;
  createdAt: string;
  finishedAt: string | null;
}

export interface UpgradePlanDetail extends UpgradePlanSummary {
  options: Record<string, unknown>;
  report: { report: UpgradeReport; markdown: string } | null;
  targetList: {
    id: string;
    kind: UpgradeTargetKind;
    label: string;
    group: string | null;
    status: string;
    preState: Record<string, unknown> | null;
    postState: Record<string, unknown> | null;
  }[];
  checks: (CheckResult & { id: string; targetId: string | null; runIndex: number })[];
  remediations: {
    id: string;
    targetId: string | null;
    remediationId: string;
    title: string;
    mode: RemediationMode;
    risk: RemediationRisk;
    status: string;
    changeSet: ChangeSet | null;
    error: string | null;
  }[];
  children: UpgradePlanSummary[];
}

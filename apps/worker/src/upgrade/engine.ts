import type { Prisma, VelnoxPrismaClient } from '@velnox/db';
import {
  ERROR_CODES,
  PERMISSIONS,
  STOPPING_SEVERITIES,
  UPGRADE_PLAYBOOKS,
  UPGRADE_REMEDIATIONS,
  buildUpgradeReport,
  changeSetRecord,
  describeGuard,
  evaluateGuard,
  playbookProblems,
  reportMarkdown,
  routeRemediation,
  type ChangeSet,
  type CheckResult,
  type Facts,
  type PlaybookStepDef,
  type UpgradeJobParams,
  type UpgradePlanStatus,
  type UpgradePlaybookDef,
} from '@velnox/shared';
import { StepError, type Playbook, type StepContext, type StepDefinition } from '../jobs/steps';
import type { LibraryServices } from '../library/services';
import { SELFTEST_ACTIONS, SELFTEST_PROVIDERS, SELFTEST_REMEDIATION_IMPLS } from './selftest';

/**
 * The generic upgrade runner (Phase 8).
 *
 * A playbook is data (packages/shared/src/upgrade.ts): steps in phases, each
 * naming an action, perhaps once per target, perhaps behind a guard. This
 * module turns one into job steps and holds the actions every playbook
 * shares — collecting facts, running checks, remediating, re-checking, the
 * gate, the report. Playbook-specific actions, check providers and
 * remediations register by name; the self-test's are in ./selftest, 9A's and
 * 9B's will sit beside them. Nothing here knows which playbook it runs.
 */

export interface UpgradeRuntime {
  prisma: VelnoxPrismaClient;
  services: LibraryServices;
  jobId: string;
  params: UpgradeJobParams;
  def: UpgradePlaybookDef;
}

export type PlanRow = Prisma.UpgradePlanGetPayload<{ include: typeof PLAN_INCLUDE }>;
export type TargetRow = PlanRow['targets'][number];

export interface ActionArgs {
  rt: UpgradeRuntime;
  step: PlaybookStepDef;
  target: TargetRow | null;
  context: StepContext;
}
export type UpgradeAction = (
  args: ActionArgs,
) => Promise<Record<string, string | number | boolean | null> | void>;

/** A check provider: findings for the plan or its targets. */
export type CheckProvider = (
  rt: UpgradeRuntime,
  plan: PlanRow,
) => Promise<(CheckResult & { targetId: string | null; source: string })[]>;

/** How a remediation is planned, applied and proven. Its metadata is in shared. */
export interface RemediationImpl {
  plan(rt: UpgradeRuntime, plan: PlanRow, targetId: string | null): Promise<ChangeSet>;
  apply(
    rt: UpgradeRuntime,
    plan: PlanRow,
    targetId: string | null,
    change: ChangeSet,
  ): Promise<void>;
  /** Whether the check it fixes now passes. */
  validate(rt: UpgradeRuntime, plan: PlanRow, targetId: string | null): Promise<boolean>;
}

const PLAN_INCLUDE = {
  targets: { orderBy: { sequence: 'asc' } },
  cluster: { select: { id: true, name: true, tenantId: true } },
} as const satisfies Prisma.UpgradePlanInclude;

function loadPlan(prisma: VelnoxPrismaClient, planId: string): Promise<PlanRow | null> {
  return prisma.upgradePlan.findUnique({ where: { id: planId }, include: PLAN_INCLUDE });
}

export async function plan(rt: UpgradeRuntime): Promise<PlanRow> {
  const row = await loadPlan(rt.prisma, rt.params.planId);
  if (!row) throw new StepError(ERROR_CODES.notFound, 'The upgrade plan is gone');
  return row;
}

/** Merge into the plan's facts — what actions keep between steps. */
export async function mergeFacts(rt: UpgradeRuntime, patch: Facts): Promise<Facts> {
  const row = await plan(rt);
  const facts = { ...(row.facts as Facts), ...patch };
  await rt.prisma.upgradePlan.update({
    where: { id: row.id },
    data: { facts: facts as Prisma.InputJsonValue },
  });
  return facts;
}

const setStatus = (
  rt: UpgradeRuntime,
  status: UpgradePlanStatus,
  extra: Prisma.UpgradePlanUpdateInput = {},
) => rt.prisma.upgradePlan.update({ where: { id: rt.params.planId }, data: { status, ...extra } });

// ---------------------------------------------------------------------------
// The actions every playbook shares
// ---------------------------------------------------------------------------

const lastRunIndex = async (rt: UpgradeRuntime): Promise<number | null> => {
  const row = await rt.prisma.upgradeCheck.findFirst({
    where: { planId: rt.params.planId },
    orderBy: { runIndex: 'desc' },
    select: { runIndex: true },
  });
  return row?.runIndex ?? null;
};

const providers = (): Record<string, CheckProvider> => ({ ...SELFTEST_PROVIDERS });
const remediationImpls = (): Record<string, RemediationImpl> => ({ ...SELFTEST_REMEDIATION_IMPLS });

const labelOf = (row: PlanRow, targetId: string | null) =>
  targetId ? (row.targets.find((t) => t.id === targetId)?.label ?? 'a target') : row.cluster.name;

const pending = (rt: UpgradeRuntime, mode: 'AUTOMATIC' | 'APPROVED') =>
  rt.prisma.remediationRun.findMany({
    where: { planId: rt.params.planId, mode, status: 'PLANNED' },
    orderBy: { createdAt: 'asc' },
  });

async function applyRemediations(
  rt: UpgradeRuntime,
  context: StepContext,
  mode: 'AUTOMATIC' | 'APPROVED',
): Promise<{ applied: number }> {
  const row = await plan(rt);
  const runs = await pending(rt, mode);
  for (const run of runs) {
    const impl = remediationImpls()[run.remediationId];
    const label = labelOf(row, run.targetId);
    const change = run.changeSet as unknown as ChangeSet;
    if (!impl) {
      throw new StepError(
        ERROR_CODES.upgradeRemediationFailed,
        `No remediation "${run.remediationId}"`,
        {
          remediation: run.remediationId,
          target: label,
        },
      );
    }
    await context.log('STDOUT', `${label}: ${change.summary} (${mode.toLowerCase()})`);
    try {
      await impl.apply(rt, row, run.targetId, change);
      await rt.prisma.remediationRun.update({
        where: { id: run.id },
        data: { status: 'APPLIED', appliedAt: new Date(), jobId: rt.jobId },
      });
      const ok = await impl.validate(rt, await plan(rt), run.targetId);
      if (!ok) throw new Error('the check it fixes still does not pass');
      await rt.prisma.remediationRun.update({
        where: { id: run.id },
        data: { status: 'VALIDATED', validatedAt: new Date() },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown';
      await rt.prisma.remediationRun.update({
        where: { id: run.id },
        data: { status: 'FAILED', error: message },
      });
      throw new StepError(
        ERROR_CODES.upgradeRemediationFailed,
        `${label}: ${change.summary} failed: ${message}`,
        { remediation: run.remediationId, target: label },
      );
    }
  }
  return { applied: runs.length };
}

export const SHARED_ACTIONS: Record<string, UpgradeAction> = {
  /** What the guards read: the cluster from the inventory. */
  'facts.collect': async ({ rt, context }) => {
    const row = await plan(rt);
    const cluster = await rt.prisma.cluster.findUnique({
      where: { id: row.clusterId },
      include: { nodes: true },
    });
    const facts = await mergeFacts(rt, {
      cluster: {
        name: cluster?.name ?? null,
        quorate: cluster?.quorate ?? null,
        nodes: cluster?.nodes.length ?? 0,
        offline: cluster?.nodes.filter((n) => n.state !== 'ONLINE').length ?? 0,
        pveVersions: cluster?.pveVersions ?? [],
      },
      ceph: { present: cluster?.cephPresent ?? false, health: cluster?.cephHealth ?? null },
    });
    await context.log(
      'STDOUT',
      `Facts: ${JSON.stringify({ cluster: facts.cluster, ceph: facts.ceph })}`,
    );
    await setStatus(rt, 'RUNNING', { startedAt: row.startedAt ?? new Date() });
    return { nodes: cluster?.nodes.length ?? 0 };
  },

  /** A step that is only its guard. */
  'guard.only': async ({ step, context }) => {
    if (step.guard) await context.log('STDOUT', `Holds: ${describeGuard(step.guard)}`);
  },

  /**
   * Run every check provider; record the findings as the next run. The first
   * run also plans a remediation for each finding that has one, routed by its
   * metadata: automatic, or waiting for a person.
   */
  'checks.run': async ({ rt, step, context }) => {
    const row = await plan(rt);
    const recheck = step.params?.recheck === true;
    const last = await lastRunIndex(rt);
    const runIndex = recheck ? (last ?? -1) + 1 : 0;
    // Running a step again after a crash replaces its own findings, nothing else.
    await rt.prisma.upgradeCheck.deleteMany({ where: { planId: row.id, runIndex } });
    const findings: (CheckResult & { targetId: string | null; source: string })[] = [];
    for (const name of rt.def.checkProviders) {
      const provider = providers()[name];
      if (!provider) throw new StepError(ERROR_CODES.validation, `No check provider "${name}"`);
      findings.push(...(await provider(rt, row)));
    }
    for (const f of findings) {
      await rt.prisma.upgradeCheck.create({
        data: {
          tenantId: row.tenantId,
          planId: row.id,
          targetId: f.targetId,
          source: f.source,
          checkKey: f.key,
          severity: f.severity,
          title: f.title,
          detail: f.detail ?? null,
          rawLine: f.rawLine ?? null,
          remediationId: f.remediationId ?? null,
          runIndex,
        },
      });
      if (f.severity !== 'PASS') {
        await context.log(
          f.severity === 'WARNING' || f.severity === 'INFO' ? 'STDOUT' : 'STDERR',
          `${f.severity} ${labelOf(row, f.targetId)}: ${f.title}`,
        );
      }
    }
    if (!recheck) {
      await rt.prisma.remediationRun.deleteMany({ where: { planId: row.id, status: 'PLANNED' } });
      for (const f of findings) {
        if (f.severity === 'PASS' || !f.remediationId) continue;
        const def = UPGRADE_REMEDIATIONS[f.remediationId];
        const impl = remediationImpls()[f.remediationId];
        if (!def || !impl) continue;
        const change = await impl.plan(rt, row, f.targetId);
        const mode = routeRemediation(def);
        await rt.prisma.remediationRun.create({
          data: {
            tenantId: row.tenantId,
            planId: row.id,
            targetId: f.targetId,
            checkKey: f.key,
            remediationId: def.id,
            risk: def.risk,
            mode,
            changeSet: change as unknown as Prisma.InputJsonValue,
          },
        });
        await context.log(
          'STDOUT',
          `${labelOf(row, f.targetId)}: "${def.title}" planned — ${mode === 'AUTOMATIC' ? 'Velnox applies it' : 'it waits for approval'}`,
        );
      }
    }
    const count = (s: string) => findings.filter((f) => f.severity === s).length;
    await context.log(
      'STDOUT',
      `Run ${runIndex}: ${findings.length} checks — ${count('PASS')} pass, ${count('WARNING')} warning, ${count('BLOCKER')} blocker, ${count('UNKNOWN')} unknown`,
    );
    return { runIndex, findings: findings.length, blockers: count('BLOCKER') + count('UNKNOWN') };
  },

  'remediate.automatic': ({ rt, context }) => applyRemediations(rt, context, 'AUTOMATIC'),
  'remediate.approved': ({ rt, context }) => applyRemediations(rt, context, 'APPROVED'),

  /** Stops the run while anything that stops an upgrade is open in the last run. */
  'checks.gate': async ({ rt, context }) => {
    const row = await plan(rt);
    const last = await lastRunIndex(rt);
    const open = await rt.prisma.upgradeCheck.findMany({
      where: { planId: row.id, runIndex: last ?? 0, severity: { in: [...STOPPING_SEVERITIES] } },
    });
    if (open.length) {
      await setStatus(rt, 'BLOCKED');
      const list = open.map((c) => `${labelOf(row, c.targetId)}: ${c.title}`);
      throw new StepError(
        ERROR_CODES.upgradeBlockersPresent,
        `${open.length} finding${open.length === 1 ? '' : 's'} still stop the upgrade: ${list.join('; ')}`,
        { count: open.length, findings: list.join('; ') },
      );
    }
    await context.log('STDOUT', 'Nothing stops the upgrade');
  },

  /** The report, kept on the plan; the plan is complete. */
  'report.build': async ({ rt, context }) => {
    await setStatus(rt, 'COMPLETED', { finishedAt: new Date() });
    const report = await writeReport(rt.prisma, rt.params.planId);
    await context.log('STDOUT', `Report written: ${report.verdict}`);
  },
};

/** Build and keep a plan's report, children included. */
export async function writeReport(prisma: VelnoxPrismaClient, planId: string) {
  const input = await reportInput(prisma, planId);
  const report = buildUpgradeReport(input);
  await prisma.upgradePlan.update({
    where: { id: planId },
    data: {
      report: { report, markdown: reportMarkdown(report) } as unknown as Prisma.InputJsonValue,
    },
  });
  return report;
}

async function reportInput(
  prisma: VelnoxPrismaClient,
  planId: string,
): Promise<Parameters<typeof buildUpgradeReport>[0]> {
  const row = await prisma.upgradePlan.findUniqueOrThrow({
    where: { id: planId },
    include: {
      targets: { orderBy: { sequence: 'asc' } },
      checks: true,
      remediations: true,
      cluster: { select: { name: true } },
      children: { orderBy: { sequence: 'asc' }, select: { id: true } },
    },
  });
  return {
    plan: {
      id: row.id,
      name: row.name,
      kind: row.kind,
      playbookId: row.playbookId,
      playbookVersion: row.playbookVersion,
      status: row.status,
      clusterName: row.cluster.name,
      startedAt: row.startedAt?.toISOString() ?? null,
      finishedAt: row.finishedAt?.toISOString() ?? null,
    },
    targets: row.targets.map((t) => ({
      id: t.id,
      kind: t.targetKind,
      label: t.label,
      group: t.daemonGroup,
      status: t.status,
      preState: (t.preState as Record<string, unknown> | null) ?? null,
      postState: (t.postState as Record<string, unknown> | null) ?? null,
    })),
    checks: row.checks.map((c) => ({
      targetId: c.targetId,
      runIndex: c.runIndex,
      key: c.checkKey,
      severity: c.severity,
      title: c.title,
    })),
    remediations: row.remediations.map((r) => ({
      targetId: r.targetId,
      remediationId: r.remediationId,
      mode: r.mode,
      risk: r.risk as 'LOW' | 'MEDIUM' | 'HIGH',
      status: r.status,
      summary: (r.changeSet as unknown as ChangeSet).summary,
    })),
    children: await Promise.all(row.children.map((c) => reportInput(prisma, c.id))),
  };
}

const ACTIONS = (): Record<string, UpgradeAction> => ({ ...SHARED_ACTIONS, ...SELFTEST_ACTIONS });
/** Every action name, for checking a playbook before it runs. */
export const knownActions = (): Set<string> =>
  new Set([...Object.keys(ACTIONS()), 'remediate.approval']);

// ---------------------------------------------------------------------------
// From playbook to job steps
// ---------------------------------------------------------------------------

export function parseUpgradeParams(raw: unknown): UpgradeJobParams {
  const v = raw as Partial<UpgradeJobParams> | null;
  if (
    !v ||
    typeof v.planId !== 'string' ||
    typeof v.clusterId !== 'string' ||
    typeof v.playbookId !== 'string' ||
    !Array.isArray(v.targets)
  ) {
    throw new StepError(
      ERROR_CODES.validation,
      'An upgrade job needs its plan, playbook and targets',
    );
  }
  return {
    planId: v.planId,
    clusterId: v.clusterId,
    playbookId: v.playbookId,
    playbookVersion: Number(v.playbookVersion ?? 1),
    targets: v.targets
      .filter((t) => t && typeof t.id === 'string')
      .map((t) => ({ id: t.id, label: String(t.label) })),
  };
}

export function upgradePlaybook(raw: unknown, jobId: string, services: LibraryServices): Playbook {
  const params = parseUpgradeParams(raw);
  const def = UPGRADE_PLAYBOOKS[params.playbookId];
  if (!def || def.version !== params.playbookVersion) {
    throw new StepError(
      ERROR_CODES.upgradeUnknownPlaybook,
      `No playbook ${params.playbookId} v${params.playbookVersion} in this worker`,
      { playbook: params.playbookId },
    );
  }
  const problems = playbookProblems(def, knownActions());
  if (problems.length) {
    throw new StepError(
      ERROR_CODES.validation,
      `Playbook ${def.id} is not valid: ${problems.join('; ')}`,
    );
  }
  const rt: UpgradeRuntime = { prisma: services.prisma, services, jobId, params, def };
  const actions = ACTIONS();

  const factsFor = async (target: TargetRow | null): Promise<Facts> => {
    const row = await plan(rt);
    return {
      ...(row.facts as Facts),
      target: target
        ? { label: target.label, group: target.daemonGroup, ...((target.preState as Facts) ?? {}) }
        : null,
    };
  };

  const taskFor = (
    step: PlaybookStepDef,
    unit: { id: string; label: string } | null,
  ): StepDefinition => {
    const action = actions[step.action]!;
    const key = unit ? `${step.key}-${params.targets.indexOf(unit) + 1}` : step.key;
    const targetOf = async () =>
      unit ? ((await plan(rt)).targets.find((t) => t.id === unit.id) ?? null) : null;
    return {
      kind: 'task',
      key,
      phase: step.phase,
      when:
        step.guard && step.onGuardFail === 'skip'
          ? async () => evaluateGuard(step.guard!, await factsFor(await targetOf())).ok
          : undefined,
      run: async (context) => {
        const target = await targetOf();
        if (step.guard && step.onGuardFail !== 'skip') {
          const result = evaluateGuard(step.guard, await factsFor(target));
          if (!result.ok) {
            await setStatus(rt, 'BLOCKED');
            throw new StepError(
              ERROR_CODES.upgradeGuardFailed,
              `${unit ? `${unit.label}: ` : ''}${result.failed.join('; ')}`,
              { step: step.key, failed: result.failed.join('; ') },
            );
          }
        }
        return action({ rt, step, target, context });
      },
    };
  };

  const steps: StepDefinition[] = [];
  for (let index = 0; index < def.steps.length; index += 1) {
    const step = def.steps[index]!;
    if (step.action === 'remediate.approval') {
      steps.push({
        kind: 'approval',
        key: step.key,
        phase: step.phase,
        requiredPermission: PERMISSIONS.upgradesExecute,
        reason: 'Remediations that Velnox does not apply by itself — the exact change is shown',
        requireDifferentApprover: false,
        when: async () => (await pending(rt, 'APPROVED')).length > 0,
        changeSet: async () => {
          const row = await plan(rt);
          const runs = await pending(rt, 'APPROVED');
          return changeSetRecord(
            runs.map((r) => ({
              label: labelOf(row, r.targetId),
              change: r.changeSet as unknown as ChangeSet,
            })),
          );
        },
      });
      continue;
    }
    if (!step.perTarget) {
      steps.push(taskFor(step, null));
      continue;
    }
    // Consecutive per-target steps go target by target: upgrade, validate,
    // then the next — never every upgrade first and every validation after.
    const group = [step];
    while (
      def.steps[index + 1]?.perTarget &&
      def.steps[index + 1]?.action !== 'remediate.approval'
    ) {
      group.push(def.steps[index + 1]!);
      index += 1;
    }
    for (const unit of params.targets)
      for (const member of group) steps.push(taskFor(member, unit));
  }

  return {
    version: 1,
    steps,
    async cleanup(reason) {
      // A plan that did not finish says so, and keeps a report of how far it got.
      const row = await loadPlan(services.prisma, params.planId);
      if (!row) return;
      const status: UpgradePlanStatus =
        reason === 'cancelled' ? 'CANCELLED' : row.status === 'BLOCKED' ? 'BLOCKED' : 'FAILED';
      await services.prisma.upgradePlan.update({
        where: { id: row.id },
        data: { status, finishedAt: new Date() },
      });
      await writeReport(services.prisma, row.id);
    },
  };
}

import type { Prisma, VelnoxPrismaClient } from '@velnox/db';
import {
  ERROR_CODES,
  type ChangeSet,
  type CheckResult,
  type Facts,
  type PlaybookStepDef,
  type UpgradeJobParams,
  type UpgradePlanStatus,
  type UpgradePlaybookDef,
} from '@velnox/shared';
import { StepError, type StepContext } from '../jobs/steps';
import type { LibraryServices } from '../library/services';

/**
 * What the upgrade engine's actions share (Phase 8): the runtime, the plan as
 * a row, and the helpers that read and write it. Its own module so that the
 * engine and the playbooks' own actions can both use it without importing
 * each other.
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
/** One finding as a provider gives it: for a target or the plan, with what its fix needs. */
export type Finding = CheckResult & {
  targetId: string | null;
  source: string;
  parserVersion?: number;
  /** Read from the finding for its remediation: the microcode package pve8to9 names. */
  params?: Record<string, string>;
};

export type CheckProvider = (rt: UpgradeRuntime, plan: PlanRow) => Promise<Finding[]>;

/** How a remediation is planned, applied and proven. Its metadata is in shared. */
export interface RemediationImpl {
  plan(
    rt: UpgradeRuntime,
    plan: PlanRow,
    targetId: string | null,
    finding: Finding,
  ): Promise<ChangeSet>;
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

export function loadPlan(prisma: VelnoxPrismaClient, planId: string): Promise<PlanRow | null> {
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

export async function setStatus(
  rt: UpgradeRuntime,
  status: UpgradePlanStatus,
  extra: Prisma.UpgradePlanUpdateInput = {},
): Promise<void> {
  await rt.prisma.upgradePlan.update({
    where: { id: rt.params.planId },
    data: { status, ...extra },
  });
}

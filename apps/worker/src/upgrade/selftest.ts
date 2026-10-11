import {
  ERROR_CODES,
  selftestOptionsSchema,
  type Facts,
  type SelftestOptions,
} from '@velnox/shared';
import { StepError } from '../jobs/steps';
import type {
  CheckProvider,
  PlanRow,
  RemediationImpl,
  UpgradeAction,
  UpgradeRuntime,
} from './engine';

/**
 * The self-test playbooks' own pieces (Phase 8). They prove the engine —
 * guards, checks, automatic and approved remediation, re-checks, the gate,
 * per-target steps, reports, composites — and change nothing outside Velnox:
 * their state is a record kept in the plan's facts. A plan's options choose
 * what is wrong at the start.
 */

interface SelftestState {
  markers: Record<string, boolean>;
  config: 'old' | 'new';
}

const optionsOf = (row: PlanRow): SelftestOptions => selftestOptionsSchema.parse(row.options ?? {});

async function stateOf(rt: UpgradeRuntime, row: PlanRow): Promise<SelftestState> {
  const facts = row.facts as Facts;
  if (facts.selftest) return facts.selftest as SelftestState;
  const options = optionsOf(row);
  const state: SelftestState = {
    markers: Object.fromEntries(row.targets.map((t) => [t.id, !options.markerMissing])),
    config: options.configOld ? 'old' : 'new',
  };
  await save(rt, row, state);
  return state;
}

async function save(rt: UpgradeRuntime, row: PlanRow, state: SelftestState) {
  const fresh = await rt.prisma.upgradePlan.findUniqueOrThrow({ where: { id: row.id } });
  await rt.prisma.upgradePlan.update({
    where: { id: row.id },
    data: { facts: { ...(fresh.facts as Facts), selftest: state } as object },
  });
}

const reload = (rt: UpgradeRuntime, row: PlanRow) =>
  rt.prisma.upgradePlan
    .findUniqueOrThrow({ where: { id: row.id } })
    .then((p) => ({ ...row, facts: p.facts }) as PlanRow);

export const SELFTEST_PROVIDERS: Record<string, CheckProvider> = {
  'selftest.marker': async (rt, row) => {
    const state = await stateOf(rt, row);
    return row.targets.map((t) => ({
      targetId: t.id,
      source: 'VELNOX_GUARD',
      key: 'selftest.marker-missing',
      severity: state.markers[t.id] ? ('PASS' as const) : ('WARNING' as const),
      title: state.markers[t.id]
        ? 'The self-test marker is there'
        : 'The self-test marker is missing',
      remediationId: 'selftest.marker',
    }));
  },
  'selftest.config': async (rt, row) => {
    const state = await stateOf(rt, row);
    const out: Awaited<ReturnType<CheckProvider>> = [
      {
        targetId: null,
        source: 'VELNOX_GUARD',
        key: 'selftest.config-old',
        severity: state.config === 'old' ? 'BLOCKER' : 'PASS',
        title:
          state.config === 'old'
            ? 'The self-test configuration is the old one'
            : 'The self-test configuration is current',
        rawLine: `mode=${state.config}`,
        remediationId: 'selftest.config',
      },
    ];
    if (optionsOf(row).unfixable && row.targets[0]) {
      out.push({
        targetId: row.targets[0].id,
        source: 'VELNOX_GUARD',
        key: 'selftest.unfixable',
        severity: 'BLOCKER',
        title: 'A blocker no remediation fixes',
      });
    }
    return out;
  },
};

const NO_PACKAGES = { install: [], remove: [] };

export const SELFTEST_REMEDIATION_IMPLS: Record<string, RemediationImpl> = {
  'selftest.marker': {
    plan: async (_rt, row, targetId) => ({
      summary: 'write the self-test marker',
      files: [
        {
          path: `velnox:selftest/${row.targets.find((t) => t.id === targetId)?.label ?? 'plan'}/marker`,
          before: null,
          after: 'ok',
        },
      ],
      commands: [],
      packages: NO_PACKAGES,
    }),
    apply: async (rt, row, targetId) => {
      const state = await stateOf(rt, row);
      if (targetId) state.markers[targetId] = true;
      await save(rt, row, state);
    },
    validate: async (rt, row, targetId) =>
      Boolean(targetId && (await stateOf(rt, await reload(rt, row))).markers[targetId]),
  },
  'selftest.config': {
    plan: async () => ({
      summary: 'switch the self-test configuration to the new mode',
      files: [{ path: 'velnox:selftest/config', before: 'mode=old', after: 'mode=new' }],
      commands: [],
      packages: NO_PACKAGES,
    }),
    apply: async (rt, row) => {
      const state = await stateOf(rt, row);
      state.config = 'new';
      await save(rt, row, state);
    },
    validate: async (rt, row) => (await stateOf(rt, await reload(rt, row))).config === 'new',
  },
};

export const SELFTEST_ACTIONS: Record<string, UpgradeAction> = {
  /** "Upgrades" a target: its state before and after, or a failure on purpose. */
  'selftest.upgrade': async ({ rt, target, context }) => {
    if (!target) return;
    const row = await rt.prisma.upgradePlan.findUniqueOrThrow({ where: { id: rt.params.planId } });
    const options = selftestOptionsSchema.parse(row.options ?? {});
    await rt.prisma.upgradeTarget.update({
      where: { id: target.id },
      data: { status: 'RUNNING', startedAt: new Date(), preState: { version: '1' } },
    });
    if (options.failTarget === target.label) {
      await rt.prisma.upgradeTarget.update({
        where: { id: target.id },
        data: { status: 'FAILED', finishedAt: new Date() },
      });
      throw new StepError(
        ERROR_CODES.upgradeTargetFailed,
        `${target.label}: the self-test was asked to fail here`,
        { target: target.label },
      );
    }
    await rt.prisma.upgradeTarget.update({
      where: { id: target.id },
      data: { postState: { version: '2' } },
    });
    await context.log(
      'STDOUT',
      `${target.label}: version 1 → 2 (self-test, nothing outside Velnox changed)`,
    );
  },
  'selftest.validate': async ({ rt, target, context }) => {
    if (!target) return;
    const fresh = await rt.prisma.upgradeTarget.findUniqueOrThrow({ where: { id: target.id } });
    const after = (fresh.postState as { version?: string } | null)?.version;
    if (after !== '2') {
      await rt.prisma.upgradeTarget.update({
        where: { id: target.id },
        data: { status: 'FAILED', finishedAt: new Date() },
      });
      throw new StepError(
        ERROR_CODES.upgradeTargetFailed,
        `${target.label} is at ${after ?? 'nothing'}, not 2`,
        {
          target: target.label,
        },
      );
    }
    await rt.prisma.upgradeTarget.update({
      where: { id: target.id },
      data: { status: 'DONE', finishedAt: new Date() },
    });
    await context.log('STDOUT', `${target.label}: validated at version 2`);
  },
};

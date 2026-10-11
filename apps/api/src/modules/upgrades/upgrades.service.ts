import { Injectable } from '@nestjs/common';
import type { Prisma } from '@velnox/db';
import {
  ERROR_CODES,
  JOB_TYPES,
  PERMISSIONS,
  UPGRADE_PLAYBOOKS,
  UPGRADE_REMEDIATIONS,
  VelnoxError,
  isAllowed,
  selftestOptionsSchema,
  type ChangeSet,
  type CreateUpgradePlanInput,
  type JobDetail,
  type UpgradeJobParams,
  type UpgradePlanDetail,
  type UpgradePlanSummary,
  type UpgradePlaybookDef,
  type UpgradeReport,
} from '@velnox/shared';
import { PrismaService } from '../infrastructure/prisma.service';
import { AuditService } from '../audit/audit.service';
import { JobsService } from '../jobs/jobs.service';
import { assertAllowedAt, type Actor } from '../../common/actor';

/**
 * Major upgrade plans (Phase 8), from the API's side: which playbooks there
 * are, making a plan with its targets from the inventory, starting it, and
 * its report. Running it is the worker's (apps/worker/src/upgrade).
 *
 * The order of a plan's targets is decided here, once: nodes by name; Ceph
 * daemons monitors first, then managers, OSDs, MDS and RGW — Ceph's own
 * upgrade order.
 */

export const UPGRADE_AUDIT = {
  planCreated: 'upgrades.plan_created',
  planDeleted: 'upgrades.plan_deleted',
} as const;

const DAEMON_ORDER = ['MON', 'MGR', 'OSD', 'MDS', 'RGW'];

interface PlannedTarget {
  targetKind: 'NODE' | 'CEPH_DAEMON';
  nodeId?: string;
  cephDaemonId?: string;
  label: string;
  daemonGroup: string | null;
  sequence: number;
}

interface PlannedPlan {
  child: { name: string; playbookId: string; options: Record<string, unknown> };
  def: UpgradePlaybookDef;
  targets: PlannedTarget[];
  options: Record<string, unknown>;
}

@Injectable()
export class UpgradesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly audit: AuditService,
  ) {}

  /** The playbooks this caller may plan with. Self-tests: those who manage the installation. */
  playbooks(
    actor: Actor,
  ): Pick<UpgradePlaybookDef, 'id' | 'version' | 'title' | 'kind' | 'targetKind' | 'internal'>[] {
    const system = isAllowed(actor.grants, PERMISSIONS.systemManage, {});
    return Object.values(UPGRADE_PLAYBOOKS)
      .filter((p) => !p.internal || system)
      .map(({ id, version, title, kind, targetKind, internal }) => ({
        id,
        version,
        title,
        kind,
        targetKind,
        internal,
      }));
  }

  private playbook(id: string, actor: Actor, tenantId: string): UpgradePlaybookDef {
    const def = UPGRADE_PLAYBOOKS[id];
    if (!def) {
      throw new VelnoxError(ERROR_CODES.upgradeUnknownPlaybook, {
        status: 400,
        params: { playbook: id },
      });
    }
    if (def.internal) assertAllowedAt(actor, PERMISSIONS.systemManage, { tenantId });
    return def;
  }

  private options(def: UpgradePlaybookDef, raw: Record<string, unknown>): Record<string, unknown> {
    if (def.kind !== 'SELFTEST') return raw;
    const parsed = selftestOptionsSchema.safeParse(raw);
    if (!parsed.success) {
      throw new VelnoxError(ERROR_CODES.validation, {
        status: 400,
        message: 'Self-test options are not valid',
      });
    }
    return parsed.data;
  }

  private async targetsFor(clusterId: string, def: UpgradePlaybookDef): Promise<PlannedTarget[]> {
    if (def.targetKind === 'NODE') {
      const nodes = await this.prisma.client.node.findMany({
        where: { clusterId },
        orderBy: { name: 'asc' },
      });
      return nodes.map((n, i) => ({
        targetKind: 'NODE' as const,
        nodeId: n.id,
        label: n.name,
        daemonGroup: null,
        sequence: i + 1,
      }));
    }
    const daemons = await this.prisma.client.cephDaemon.findMany({ where: { clusterId } });
    return daemons
      .sort(
        (a, b) =>
          DAEMON_ORDER.indexOf(a.kind) - DAEMON_ORDER.indexOf(b.kind) ||
          a.daemonId.localeCompare(b.daemonId, undefined, { numeric: true }),
      )
      .map((d, i) => ({
        targetKind: 'CEPH_DAEMON' as const,
        cephDaemonId: d.id,
        label: d.daemonId,
        daemonGroup: d.kind,
        sequence: i + 1,
      }));
  }

  async create(input: CreateUpgradePlanInput, actor: Actor): Promise<UpgradePlanDetail> {
    const cluster = await this.prisma.client.cluster.findUnique({ where: { id: input.clusterId } });
    if (!cluster) throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });
    assertAllowedAt(actor, PERMISSIONS.upgradesExecute, {
      tenantId: cluster.tenantId,
      clusterId: cluster.id,
    });

    const children =
      input.kind === 'COMPOSITE'
        ? input.children
        : [{ name: input.name, playbookId: input.playbookId, options: input.options }];
    const planned: PlannedPlan[] = [];
    for (const child of children) {
      const def = this.playbook(child.playbookId, actor, cluster.tenantId);
      const targets = await this.targetsFor(cluster.id, def);
      if (!targets.length) {
        throw new VelnoxError(ERROR_CODES.validation, {
          status: 400,
          message:
            def.targetKind === 'NODE'
              ? 'The cluster has no nodes in the inventory'
              : 'The cluster has no Ceph daemons in the inventory',
        });
      }
      planned.push({ child, def, targets, options: this.options(def, child.options) });
    }

    const common = {
      tenantId: cluster.tenantId,
      clusterId: cluster.id,
      createdByUserId: actor.id,
      createdByLabel: actor.email,
    };
    const id = await this.prisma.client.$transaction(async (tx) => {
      const make = (p: PlannedPlan, parentPlanId: string | null, sequence: number) =>
        tx.upgradePlan.create({
          data: {
            ...common,
            name: p.child.name,
            kind: p.def.kind,
            playbookId: p.def.id,
            playbookVersion: p.def.version,
            parentPlanId,
            sequence,
            options: p.options as Prisma.InputJsonValue,
            targets: { create: p.targets.map((t) => ({ ...t, tenantId: cluster.tenantId })) },
          },
        });
      if (input.kind === 'PLAYBOOK') return (await make(planned[0]!, null, 1)).id;
      const parent = await tx.upgradePlan.create({
        data: { ...common, name: input.name, kind: 'COMPOSITE', playbookId: null },
      });
      for (const [i, p] of planned.entries()) await make(p, parent.id, i + 1);
      return parent.id;
    });
    await this.audit.success(UPGRADE_AUDIT.planCreated, {
      actorType: 'USER',
      actorId: actor.id,
      actorLabel: actor.email,
      tenantId: cluster.tenantId,
      resourceType: 'upgrade_plan',
      resourceId: id,
      resourceLabel: input.name,
      metadata: { cluster: cluster.name, playbooks: planned.map((p) => p.def.id) },
    });
    return this.detail(id);
  }

  async list(filter: { clusterId?: string }): Promise<UpgradePlanSummary[]> {
    const rows = await this.prisma.client.upgradePlan.findMany({
      where: { parentPlanId: null, ...(filter.clusterId ? { clusterId: filter.clusterId } : {}) },
      include: { cluster: { select: { name: true } }, _count: { select: { targets: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return Promise.all(rows.map((r) => this.summary(r)));
  }

  private async summary(r: {
    id: string;
    name: string;
    kind: UpgradePlanSummary['kind'];
    status: UpgradePlanSummary['status'];
    clusterId: string;
    cluster: { name: string };
    playbookId: string | null;
    parentPlanId: string | null;
    jobId: string | null;
    createdAt: Date;
    finishedAt: Date | null;
    _count: { targets: number };
  }): Promise<UpgradePlanSummary> {
    const job = r.jobId
      ? await this.prisma.client.job.findUnique({
          where: { id: r.jobId },
          select: { status: true },
        })
      : null;
    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      status: r.status,
      clusterId: r.clusterId,
      clusterName: r.cluster.name,
      playbookId: r.playbookId,
      playbookTitle: r.playbookId ? (UPGRADE_PLAYBOOKS[r.playbookId]?.title ?? r.playbookId) : null,
      parentPlanId: r.parentPlanId,
      jobId: r.jobId,
      jobStatus: job?.status ?? null,
      targets: r._count.targets,
      createdAt: r.createdAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
    };
  }

  async detail(id: string): Promise<UpgradePlanDetail> {
    const row = await this.prisma.client.upgradePlan.findUnique({
      where: { id },
      include: {
        cluster: { select: { name: true } },
        _count: { select: { targets: true } },
        targets: { orderBy: { sequence: 'asc' } },
        checks: { orderBy: [{ runIndex: 'asc' }, { createdAt: 'asc' }] },
        remediations: { orderBy: { createdAt: 'asc' } },
        children: {
          orderBy: { sequence: 'asc' },
          include: { cluster: { select: { name: true } }, _count: { select: { targets: true } } },
        },
      },
    });
    if (!row) throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });
    return {
      ...(await this.summary(row)),
      options: (row.options ?? {}) as Record<string, unknown>,
      report: (row.report as { report: UpgradeReport; markdown: string } | null) ?? null,
      targetList: row.targets.map((t) => ({
        id: t.id,
        kind: t.targetKind,
        label: t.label,
        group: t.daemonGroup,
        status: t.status,
        preState: (t.preState as Record<string, unknown> | null) ?? null,
        postState: (t.postState as Record<string, unknown> | null) ?? null,
      })),
      checks: row.checks.map((c) => ({
        id: c.id,
        targetId: c.targetId,
        runIndex: c.runIndex,
        key: c.checkKey,
        severity: c.severity,
        title: c.title,
        detail: c.detail ?? undefined,
        rawLine: c.rawLine ?? undefined,
        remediationId: c.remediationId ?? undefined,
      })),
      remediations: row.remediations.map((r) => ({
        id: r.id,
        targetId: r.targetId,
        remediationId: r.remediationId,
        title: UPGRADE_REMEDIATIONS[r.remediationId]?.title ?? r.remediationId,
        mode: r.mode,
        risk: r.risk as 'LOW' | 'MEDIUM' | 'HIGH',
        status: r.status,
        changeSet: (r.changeSet as unknown as ChangeSet) ?? null,
        error: r.error,
      })),
      children: await Promise.all(row.children.map((c) => this.summary(c))),
    };
  }

  private async draft(id: string, actor: Actor) {
    const row = await this.prisma.client.upgradePlan.findUnique({
      where: { id },
      include: { targets: { orderBy: { sequence: 'asc' } }, cluster: { select: { name: true } } },
    });
    if (!row) throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });
    assertAllowedAt(actor, PERMISSIONS.upgradesExecute, {
      tenantId: row.tenantId,
      clusterId: row.clusterId,
    });
    if (row.playbookId && UPGRADE_PLAYBOOKS[row.playbookId]?.internal) {
      assertAllowedAt(actor, PERMISSIONS.systemManage, { tenantId: row.tenantId });
    }
    if (row.parentPlanId) {
      throw new VelnoxError(ERROR_CODES.validation, {
        status: 409,
        message: 'A child plan runs as part of its composite',
      });
    }
    if (row.status !== 'DRAFT') {
      throw new VelnoxError(ERROR_CODES.upgradeNotDraft, {
        status: 409,
        params: { status: row.status },
      });
    }
    return row;
  }

  /** Start a plan: one job for a playbook plan; a composite's children start one by one. */
  async run(id: string, actor: Actor): Promise<{ plan: UpgradePlanDetail; job: JobDetail | null }> {
    const row = await this.draft(id, actor);
    if (row.kind === 'COMPOSITE') {
      await this.prisma.client.upgradePlan.update({ where: { id }, data: { status: 'RUNNING' } });
      return { plan: await this.detail(id), job: null };
    }
    const params: UpgradeJobParams = {
      planId: row.id,
      clusterId: row.clusterId,
      playbookId: row.playbookId!,
      playbookVersion: row.playbookVersion ?? 1,
      targets: row.targets.map((t) => ({ id: t.id, label: t.label })),
    };
    const job = await this.jobs.create(
      {
        tenantId: row.tenantId,
        type: JOB_TYPES.upgradeRun,
        params: params as unknown as Prisma.InputJsonValue,
        concurrencyKey: `cluster:${row.clusterId}`,
        concurrencyLabel: row.cluster.name,
        targetKind: 'cluster',
        targetIds: [row.clusterId],
        parentJobId: null,
      },
      actor,
    );
    await this.prisma.client.upgradePlan.update({
      where: { id },
      data: { status: 'RUNNING', jobId: job.id, startedAt: new Date() },
    });
    return { plan: await this.detail(id), job };
  }

  async remove(id: string, actor: Actor): Promise<void> {
    const row = await this.draft(id, actor);
    await this.prisma.client.upgradePlan.delete({ where: { id } });
    await this.audit.success(UPGRADE_AUDIT.planDeleted, {
      actorType: 'USER',
      actorId: actor.id,
      actorLabel: actor.email,
      tenantId: row.tenantId,
      resourceType: 'upgrade_plan',
      resourceId: id,
      resourceLabel: row.name,
      metadata: { cluster: row.cluster.name },
    });
  }

  async report(id: string): Promise<{ report: UpgradeReport; markdown: string }> {
    const row = await this.prisma.client.upgradePlan.findUnique({
      where: { id },
      select: { report: true },
    });
    if (!row) throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });
    if (!row.report) {
      throw new VelnoxError(ERROR_CODES.validation, {
        status: 409,
        message: 'The plan has no report yet',
      });
    }
    return row.report as unknown as { report: UpgradeReport; markdown: string };
  }
}

import { Injectable } from '@nestjs/common';
import type { Prisma } from '@velnox/db';
import {
  DEFAULT_PLACEMENT_SETTINGS,
  ERROR_CODES,
  JOB_TYPES,
  PERMISSIONS,
  VelnoxError,
  contradicts,
  haRuleId,
  hasHaRules,
  isAllowed,
  placementViolations,
  type JobDetail,
  type PlacementClusterView,
  type PlacementHaState,
  type PlacementJobParams,
  type PlacementReason,
  type PlacementRuleInput,
  type PlacementRuleLike,
  type PlacementSettingsInput,
} from '@velnox/shared';
import { PrismaService } from '../infrastructure/prisma.service';
import { AuditService } from '../audit/audit.service';
import { JobsService } from '../jobs/jobs.service';
import { assertAllowedAt, type Actor } from '../../common/actor';

/**
 * Placement (Phase 7B), from the API's side: the rules, whether they hold by
 * the inventory, the settings, and starting a correction or a balancing run.
 *
 * Writing a rule into Proxmox's HA rules (PVE 9) and moving guests are the
 * worker's (ADR-009 keeps the Proxmox adapter out of the API): a saved rule is
 * written there within half a minute, and the screen says when it is held.
 */

export const PLACEMENT_AUDIT = {
  ruleSaved: 'placement.rule_saved',
  ruleDeleted: 'placement.rule_deleted',
  settingsSaved: 'placement.settings_saved',
} as const;

@Injectable()
export class PlacementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly audit: AuditService,
  ) {}

  private async clusterRow(clusterId: string) {
    const cluster = await this.prisma.client.cluster.findUnique({
      where: { id: clusterId },
      include: { nodes: { orderBy: { name: 'asc' } }, placementSettings: true },
    });
    if (!cluster) throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });
    return cluster;
  }

  private liveRules(clusterId: string) {
    return this.prisma.client.placementRule.findMany({
      where: { clusterId, deletedAt: null },
      orderBy: [{ createdAt: 'asc' }],
    });
  }

  async view(clusterId: string, actor: Actor): Promise<PlacementClusterView> {
    const cluster = await this.clusterRow(clusterId);
    const haRules = hasHaRules(cluster.pveVersions);
    const rows = await this.liveRules(clusterId);
    const workloads = await this.prisma.client.workload.findMany({
      where: { clusterId, template: false },
      include: { node: { select: { name: true } } },
      orderBy: { vmid: 'asc' },
    });
    const positions = new Map(
      workloads.filter((w) => w.state === 'RUNNING' && w.node).map((w) => [w.vmid, w.node!.name]),
    );
    const rules: PlacementRuleLike[] = rows.map((r) => ({ ...r }));
    const violations = placementViolations(rules, positions);
    const jobs = await this.prisma.client.job.findMany({
      where: { type: JOB_TYPES.placement, targetIds: { has: clusterId } },
      orderBy: { queuedAt: 'desc' },
      take: 10,
      select: { id: true, status: true, params: true, queuedAt: true },
    });
    const settings = cluster.placementSettings;
    return {
      cluster: {
        id: cluster.id,
        name: cluster.name,
        tenantId: cluster.tenantId,
        pveVersions: cluster.pveVersions,
        haRules,
        whole:
          cluster.quorate !== false &&
          cluster.nodes.length > 0 &&
          cluster.nodes.every((n) => n.state === 'ONLINE'),
      },
      rules: rows.map((r) => {
        let state: PlacementHaState = 'velnox';
        if (haRules) {
          if (r.haSyncError) state = 'error';
          else if (r.haSyncedAt && r.haRuleId === haRuleId(r.id) && r.haSyncedAt >= r.updatedAt)
            state = 'synced';
          else state = 'pending';
        }
        return {
          id: r.id,
          name: r.name,
          kind: r.kind,
          vmids: r.vmids,
          nodes: r.nodes,
          strict: r.strict,
          enabled: r.enabled,
          violations: violations.filter((v) => v.ruleId === r.id),
          ha: {
            state,
            ruleId: r.haRuleId,
            syncedAt: r.haSyncedAt?.toISOString() ?? null,
            error: r.haSyncError,
          },
          createdBy: r.createdByLabel,
          updatedAt: r.updatedAt.toISOString(),
        };
      }),
      settings: settings
        ? {
            autoCorrect: settings.autoCorrect,
            balance: settings.balance,
            balanceThresholdPercent: settings.balanceThresholdPercent,
            quietMinutes: settings.quietMinutes,
          }
        : DEFAULT_PLACEMENT_SETTINGS,
      guests: workloads.map((w) => ({
        vmid: w.vmid,
        kind: w.kind === 'LXC' ? 'lxc' : 'qemu',
        name: w.name,
        node: w.node?.name ?? null,
        running: w.state === 'RUNNING',
      })),
      nodes: cluster.nodes.map((n) => ({
        name: n.name,
        online: n.state === 'ONLINE',
        memoryUsedPercent:
          n.memoryTotalBytes && n.memoryTotalBytes > 0n
            ? Math.round((Number(n.memoryUsedBytes ?? 0n) / Number(n.memoryTotalBytes)) * 1000) / 10
            : null,
      })),
      jobs: jobs.map((j) => {
        const p = (j.params ?? {}) as Partial<PlacementJobParams>;
        return {
          id: j.id,
          status: j.status,
          reason: p.reason ?? null,
          queuedAt: j.queuedAt.toISOString(),
          by: p.by ?? null,
        };
      }),
      canManage: isAllowed(actor.grants, PERMISSIONS.placementManage, {
        tenantId: cluster.tenantId,
        clusterId: cluster.id,
      }),
    };
  }

  private async checkRule(
    cluster: Awaited<ReturnType<PlacementService['clusterRow']>>,
    input: PlacementRuleInput,
    exceptId: string | null,
  ) {
    const known = await this.prisma.client.workload.findMany({
      where: { clusterId: cluster.id, vmid: { in: input.vmids }, template: false },
      select: { vmid: true },
    });
    const missing = input.vmids.filter((v) => !known.some((k) => k.vmid === v));
    const nodeNames = new Set(cluster.nodes.map((n) => n.name));
    const missingNodes = input.nodes.filter((n) => !nodeNames.has(n));
    if (missing.length || missingNodes.length) {
      throw new VelnoxError(ERROR_CODES.placementUnknownMember, {
        status: 400,
        params: { members: [...missing.map(String), ...missingNodes].join(', ') },
      });
    }
    if (input.kind === 'KEEP_APART' && input.vmids.length > cluster.nodes.length) {
      throw new VelnoxError(ERROR_CODES.placementImpossible, {
        status: 400,
        params: { guests: input.vmids.length, nodes: cluster.nodes.length },
      });
    }
    const others = (await this.liveRules(cluster.id))
      .filter((r) => r.id !== exceptId)
      .map((r) => ({ ...r }));
    const clash = input.enabled ? contradicts(input, others) : null;
    if (clash) {
      throw new VelnoxError(ERROR_CODES.placementContradiction, {
        status: 409,
        params: { rule: clash },
      });
    }
  }

  async createRule(clusterId: string, input: PlacementRuleInput, actor: Actor) {
    const cluster = await this.clusterRow(clusterId);
    assertAllowedAt(actor, PERMISSIONS.placementManage, {
      tenantId: cluster.tenantId,
      clusterId: cluster.id,
    });
    await this.checkRule(cluster, input, null);
    const row = await this.unique(() =>
      this.prisma.client.placementRule.create({
        data: { ...input, clusterId, tenantId: cluster.tenantId, createdByLabel: actor.email },
      }),
    );
    await this.audited(PLACEMENT_AUDIT.ruleSaved, cluster.tenantId, row.id, row.name, actor, {
      ...input,
      cluster: cluster.name,
    });
    return { id: row.id };
  }

  private async ruleRow(id: string) {
    const row = await this.prisma.client.placementRule.findUnique({ where: { id } });
    if (!row || row.deletedAt) throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });
    return row;
  }

  async updateRule(id: string, input: PlacementRuleInput, actor: Actor) {
    const row = await this.ruleRow(id);
    const cluster = await this.clusterRow(row.clusterId);
    assertAllowedAt(actor, PERMISSIONS.placementManage, {
      tenantId: cluster.tenantId,
      clusterId: cluster.id,
    });
    await this.checkRule(cluster, input, id);
    await this.unique(() =>
      this.prisma.client.placementRule.update({ where: { id }, data: { ...input } }),
    );
    await this.audited(PLACEMENT_AUDIT.ruleSaved, cluster.tenantId, id, input.name, actor, {
      ...input,
      cluster: cluster.name,
    });
    return { id };
  }

  /**
   * A removed rule stops counting at once. On PVE 9 its row stays, marked,
   * until the worker has removed it from Proxmox's HA rules too.
   */
  async deleteRule(id: string, actor: Actor): Promise<void> {
    const row = await this.ruleRow(id);
    const cluster = await this.clusterRow(row.clusterId);
    assertAllowedAt(actor, PERMISSIONS.placementManage, {
      tenantId: cluster.tenantId,
      clusterId: cluster.id,
    });
    if (hasHaRules(cluster.pveVersions)) {
      await this.prisma.client.placementRule.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
    } else {
      await this.prisma.client.placementRule.delete({ where: { id } });
    }
    await this.audited(PLACEMENT_AUDIT.ruleDeleted, cluster.tenantId, id, row.name, actor, {
      cluster: cluster.name,
    });
  }

  async saveSettings(clusterId: string, input: PlacementSettingsInput, actor: Actor) {
    const cluster = await this.clusterRow(clusterId);
    assertAllowedAt(actor, PERMISSIONS.placementManage, {
      tenantId: cluster.tenantId,
      clusterId: cluster.id,
    });
    await this.prisma.client.placementSettings.upsert({
      where: { clusterId },
      create: { ...input, clusterId, tenantId: cluster.tenantId },
      update: { ...input },
    });
    await this.audited(
      PLACEMENT_AUDIT.settingsSaved,
      cluster.tenantId,
      cluster.id,
      cluster.name,
      actor,
      { ...input },
    );
    return input;
  }

  /** Move guests to meet the rules, or one to even out memory, now. */
  async start(clusterId: string, reason: PlacementReason, actor: Actor): Promise<JobDetail> {
    const cluster = await this.clusterRow(clusterId);
    assertAllowedAt(actor, PERMISSIONS.placementManage, {
      tenantId: cluster.tenantId,
      clusterId: cluster.id,
    });
    const down = cluster.nodes.filter((n) => n.state !== 'ONLINE');
    if (cluster.quorate === false || down.length) {
      throw new VelnoxError(ERROR_CODES.placementClusterDegraded, {
        status: 409,
        params: {
          reason: down.length ? `${down.map((n) => n.name).join(', ')} offline` : 'no quorum',
        },
      });
    }
    const params: PlacementJobParams = {
      clusterId,
      reason,
      by: null,
      balanceThresholdPercent:
        cluster.placementSettings?.balanceThresholdPercent ??
        DEFAULT_PLACEMENT_SETTINGS.balanceThresholdPercent,
    };
    return this.jobs.create(
      {
        tenantId: cluster.tenantId,
        type: JOB_TYPES.placement,
        params: params as unknown as Prisma.InputJsonValue,
        concurrencyKey: `cluster:${cluster.id}`,
        concurrencyLabel: cluster.name,
        targetKind: 'cluster',
        targetIds: [cluster.id],
        parentJobId: null,
      },
      actor,
    );
  }

  private async unique<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'P2002') {
        throw new VelnoxError(ERROR_CODES.validation, {
          status: 409,
          message: 'This cluster already has a placement rule by that name',
        });
      }
      throw error;
    }
  }

  private async audited(
    action: string,
    tenantId: string,
    id: string,
    label: string,
    actor: Actor,
    metadata: Record<string, unknown>,
  ) {
    await this.audit.success(action, {
      actorType: 'USER',
      actorId: actor.id,
      actorLabel: actor.email,
      tenantId,
      resourceType: action.includes('settings') ? 'placement_settings' : 'placement_rule',
      resourceId: id,
      resourceLabel: label,
      metadata,
    });
  }
}

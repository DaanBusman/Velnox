import { Injectable } from '@nestjs/common';
import type { Prisma } from '@velnox/db';
import {
  ACTIVE_JOB_STATUSES,
  ERROR_CODES,
  JOB_TYPES,
  PERMISSIONS,
  VelnoxError,
  isAllowed,
  windowState,
  type JobDetail,
  type MaintenanceWindowInput,
  type MaintenanceWindowSummary,
  type NodeUpdateParams,
  type NodeUpdatesSummary,
  type PendingPackage,
  type RebootPolicy,
  type UpdatePolicyInput,
  type UpdatePolicySummary,
} from '@velnox/shared';
import { PrismaService } from '../infrastructure/prisma.service';
import { AuditService } from '../audit/audit.service';
import { JobsService } from '../jobs/jobs.service';
import { assertAllowedAt, type Actor } from '../../common/actor';

/**
 * Update management (Phase 6), from the API's side.
 *
 * Reading is the tenancy filter's: a node's updates, windows and policies are
 * its cluster's tenant's. Running an update needs `updates.execute` on the
 * node's cluster; windows and policies need `updates.manage`. The API decides
 * and records; applying is the worker's, as a node.update job (ADR-046).
 */

export const UPDATE_AUDIT = {
  windowSaved: 'updates.window_saved',
  windowDeleted: 'updates.window_deleted',
  policySaved: 'updates.policy_saved',
  policyDeleted: 'updates.policy_deleted',
} as const;

@Injectable()
export class UpdatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // Nodes
  // -------------------------------------------------------------------------

  async nodes(filter: { clusterId?: string }): Promise<NodeUpdatesSummary[]> {
    const nodes = await this.prisma.client.node.findMany({
      where: filter.clusterId ? { clusterId: filter.clusterId } : {},
      include: {
        cluster: {
          select: {
            id: true,
            name: true,
            tenantId: true,
            sshCredentialId: true,
            tenant: { select: { name: true } },
            updatePolicy: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: [{ cluster: { name: 'asc' } }, { name: 'asc' }],
    });
    const active = await this.prisma.client.job.findMany({
      where: { type: JOB_TYPES.nodeUpdate, status: { in: [...ACTIVE_JOB_STATUSES] } },
      select: { id: true, targetIds: true },
    });
    return nodes.map((node) => ({
      nodeId: node.id,
      node: node.name,
      clusterId: node.clusterId,
      clusterName: node.cluster.name,
      tenantId: node.tenantId,
      tenantName: node.cluster.tenant.name,
      online: node.state === 'ONLINE',
      pveVersion: node.pveVersion,
      runningKernel: node.runningKernel ?? node.kernelVersion,
      total: node.updatesAvailable ?? 0,
      security: node.updatesSecurity ?? 0,
      kernel: node.updatesKernel ?? 0,
      proxmox: node.updatesProxmox ?? 0,
      rebootRequired: node.rebootRequired,
      rebootReason: node.rebootRequiredReason,
      checkedAt: node.updatesCheckedAt?.toISOString() ?? null,
      canApply: Boolean(node.cluster.sshCredentialId && node.sshHostKeyFingerprint),
      activeJobId: active.find((job) => job.targetIds.includes(node.id))?.id ?? null,
      policy: node.cluster.updatePolicy,
    }));
  }

  async packages(nodeId: string): Promise<PendingPackage[]> {
    await this.node(nodeId);
    const rows = await this.prisma.client.nodePackageUpdate.findMany({
      where: { nodeId },
      orderBy: [{ isSecurity: 'desc' }, { isKernel: 'desc' }, { package: 'asc' }],
    });
    return rows.map((row) => ({
      package: row.package,
      currentVersion: row.currentVersion,
      candidateVersion: row.candidateVersion,
      origin: row.origin,
      isSecurity: row.isSecurity,
      isKernel: row.isKernel,
      isProxmox: row.isProxmox,
    }));
  }

  private async node(nodeId: string) {
    const node = await this.prisma.client.node.findUnique({
      where: { id: nodeId },
      include: {
        cluster: {
          select: {
            id: true,
            tenantId: true,
            sshCredentialId: true,
            updatePolicy: { include: { window: true } },
          },
        },
      },
    });
    if (!node) throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });
    return node;
  }

  /**
   * Update a node now. Under a policy, its approval, reboot policy and window
   * apply: outside the window the request is refused with when it next opens,
   * rather than queued to wait — a person asking for an update now should hear
   * that it cannot happen now.
   */
  async run(
    nodeId: string,
    input: { rebootPolicy?: RebootPolicy },
    actor: Actor,
  ): Promise<JobDetail> {
    const node = await this.node(nodeId);
    assertAllowedAt(actor, PERMISSIONS.updatesExecute, {
      tenantId: node.tenantId,
      clusterId: node.clusterId,
    });
    if (!node.cluster.sshCredentialId || !node.sshHostKeyFingerprint) {
      throw new VelnoxError(ERROR_CODES.updateSshRequired, {
        status: 409,
        params: { node: node.name },
      });
    }
    const policy = node.cluster.updatePolicy?.enabled ? node.cluster.updatePolicy : null;
    if (policy?.window) {
      const state = windowState(policy.window, Date.now());
      if (!state.open) {
        throw new VelnoxError(ERROR_CODES.updateOutsideWindow, {
          status: 409,
          params: {
            window: policy.window.name,
            nextOpening: state.nextOpening ? new Date(state.nextOpening).toISOString() : null,
          },
        });
      }
    }
    const params: NodeUpdateParams = {
      clusterId: node.clusterId,
      nodeId: node.id,
      node: node.name,
      rebootPolicy: input.rebootPolicy ?? policy?.rebootPolicy ?? 'IF_REQUIRED',
      requireApproval: policy?.requireApproval ?? false,
      maintenanceWindowId: policy?.maintenanceWindowId ?? null,
      policyId: policy?.id ?? null,
      pending: {
        total: node.updatesAvailable ?? 0,
        security: node.updatesSecurity ?? 0,
        kernel: node.updatesKernel ?? 0,
        proxmox: node.updatesProxmox ?? 0,
      },
    };
    return this.jobs.create(
      {
        tenantId: node.tenantId,
        type: JOB_TYPES.nodeUpdate,
        params: params as unknown as Prisma.InputJsonValue,
        concurrencyKey: `cluster:${node.clusterId}`,
        concurrencyLabel: node.name,
        targetKind: 'node',
        targetIds: [node.id],
        parentJobId: null,
      },
      actor,
    );
  }

  // -------------------------------------------------------------------------
  // Windows
  // -------------------------------------------------------------------------

  async windows(): Promise<MaintenanceWindowSummary[]> {
    const rows = await this.prisma.client.maintenanceWindow.findMany({
      include: { tenant: { select: { name: true } } },
      orderBy: [{ tenantId: 'asc' }, { name: 'asc' }],
    });
    const now = Date.now();
    return rows.map((row) => {
      const state = windowState(row, now);
      return {
        id: row.id,
        tenantId: row.tenantId,
        tenantName: row.tenant.name,
        name: row.name,
        timezone: row.timezone,
        rrule: row.rrule,
        durationMinutes: row.durationMinutes,
        blackoutDates: row.blackoutDates,
        open: state.open,
        nextOpening: state.nextOpening ? new Date(state.nextOpening).toISOString() : null,
        closesAt: state.closesAt ? new Date(state.closesAt).toISOString() : null,
      };
    });
  }

  async saveWindow(
    id: string | null,
    input: MaintenanceWindowInput & { tenantId: string },
    actor: Actor,
  ): Promise<MaintenanceWindowSummary> {
    const tenantId = id ? (await this.windowRow(id)).tenantId : input.tenantId;
    assertAllowedAt(actor, PERMISSIONS.updatesManage, { tenantId });
    const data = {
      name: input.name,
      timezone: input.timezone,
      rrule: input.rrule.replace(/^RRULE:/i, '').toUpperCase(),
      durationMinutes: input.durationMinutes,
      blackoutDates: input.blackoutDates,
    };
    let row;
    try {
      row = id
        ? await this.prisma.client.maintenanceWindow.update({ where: { id }, data })
        : await this.prisma.client.maintenanceWindow.create({
            data: { ...data, tenantId, createdByLabel: actor.email },
          });
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'P2002') {
        throw new VelnoxError(ERROR_CODES.validation, {
          status: 409,
          message: 'This tenant already has a window by that name',
        });
      }
      throw error;
    }
    await this.audited(UPDATE_AUDIT.windowSaved, tenantId, row.id, row.name, actor, data);
    return (await this.windows()).find((w) => w.id === row.id)!;
  }

  private async windowRow(id: string) {
    const row = await this.prisma.client.maintenanceWindow.findUnique({ where: { id } });
    if (!row) throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });
    return row;
  }

  async deleteWindow(id: string, actor: Actor): Promise<void> {
    const row = await this.windowRow(id);
    assertAllowedAt(actor, PERMISSIONS.updatesManage, { tenantId: row.tenantId });
    const used = await this.prisma.client.updatePolicy.count({
      where: { maintenanceWindowId: id },
    });
    if (used > 0) {
      throw new VelnoxError(ERROR_CODES.maintenanceWindowInUse, {
        status: 409,
        params: { policies: used },
      });
    }
    await this.prisma.client.maintenanceWindow.delete({ where: { id } });
    await this.audited(UPDATE_AUDIT.windowDeleted, row.tenantId, row.id, row.name, actor, {});
  }

  // -------------------------------------------------------------------------
  // Policies
  // -------------------------------------------------------------------------

  async policies(): Promise<UpdatePolicySummary[]> {
    const rows = await this.prisma.client.updatePolicy.findMany({
      include: { cluster: { select: { name: true } }, window: { select: { name: true } } },
      orderBy: { cluster: { name: 'asc' } },
    });
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      clusterId: row.clusterId,
      clusterName: row.cluster.name,
      name: row.name,
      enabled: row.enabled,
      autoApply: row.autoApply,
      requireApproval: row.requireApproval,
      rebootPolicy: row.rebootPolicy,
      maintenanceWindowId: row.maintenanceWindowId,
      windowName: row.window?.name ?? null,
    }));
  }

  /** One policy per cluster: saving for a cluster replaces its policy. */
  async savePolicy(input: UpdatePolicyInput, actor: Actor): Promise<UpdatePolicySummary> {
    const cluster = await this.prisma.client.cluster.findUnique({
      where: { id: input.clusterId },
      select: { id: true, tenantId: true },
    });
    if (!cluster) throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });
    assertAllowedAt(actor, PERMISSIONS.updatesManage, {
      tenantId: cluster.tenantId,
      clusterId: cluster.id,
    });
    if (input.maintenanceWindowId) {
      const window = await this.windowRow(input.maintenanceWindowId);
      if (window.tenantId !== cluster.tenantId) {
        throw new VelnoxError(ERROR_CODES.validation, {
          status: 400,
          message: 'A policy’s window belongs to the cluster’s tenant',
        });
      }
    }
    if (input.autoApply && !input.maintenanceWindowId) {
      throw new VelnoxError(ERROR_CODES.validation, {
        status: 400,
        message: 'Updating by itself needs a maintenance window',
        params: { field: 'maintenanceWindowId' },
      });
    }
    const data = {
      name: input.name,
      enabled: input.enabled,
      autoApply: input.autoApply,
      requireApproval: input.requireApproval,
      rebootPolicy: input.rebootPolicy,
      maintenanceWindowId: input.maintenanceWindowId,
    };
    const row = await this.prisma.client.updatePolicy.upsert({
      where: { clusterId: cluster.id },
      create: {
        ...data,
        clusterId: cluster.id,
        tenantId: cluster.tenantId,
        createdByLabel: actor.email,
      },
      update: data,
    });
    await this.audited(UPDATE_AUDIT.policySaved, cluster.tenantId, row.id, row.name, actor, {
      ...data,
      clusterId: cluster.id,
    });
    return (await this.policies()).find((p) => p.id === row.id)!;
  }

  async deletePolicy(id: string, actor: Actor): Promise<void> {
    const row = await this.prisma.client.updatePolicy.findUnique({ where: { id } });
    if (!row) throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });
    assertAllowedAt(actor, PERMISSIONS.updatesManage, {
      tenantId: row.tenantId,
      clusterId: row.clusterId,
    });
    await this.prisma.client.updatePolicy.delete({ where: { id } });
    await this.audited(UPDATE_AUDIT.policyDeleted, row.tenantId, row.id, row.name, actor, {});
  }

  /** Whether this actor may manage policies somewhere — for the screen. */
  canManage(actor: Actor): boolean {
    return actor.accessibleTenantIds.some((tenantId) =>
      isAllowed(actor.grants, PERMISSIONS.updatesManage, { tenantId }),
    );
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
      resourceType: action.includes('window') ? 'maintenance_window' : 'update_policy',
      resourceId: id,
      resourceLabel: label,
      metadata: metadata as Record<string, unknown>,
    });
  }
}

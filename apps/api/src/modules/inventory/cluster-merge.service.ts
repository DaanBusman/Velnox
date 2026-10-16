import { Injectable } from '@nestjs/common';
import {
  ACTIVE_JOB_STATUSES,
  ERROR_CODES,
  JOB_NAMES,
  PERMISSIONS,
  VelnoxError,
  isAllowed,
  mergeCandidates,
  sameProxmoxCluster,
  type ClusterMergeCandidate,
  type ClusterMergeInput,
} from '@velnox/shared';
import { PrismaService } from '../infrastructure/prisma.service';
import { QueueService } from '../infrastructure/queue.service';
import { SecretStoreService } from '../auth/secret-store.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { assertAllowedAt, type Actor } from '../../common/actor';

/**
 * Merging two registrations of one Proxmox cluster (ADR-055).
 *
 * Velnox does not join nodes — the operator forms the cluster in Proxmox, as
 * the owner chose. What Velnox does is notice that two of its registrations
 * now report the same Proxmox cluster, and on request make them one: the
 * registration that stays is renamed, and what the other held moves to it —
 * its SSH key and host-key pins, placement rules and settings, update policy,
 * upgrade plans, VM builds, library sources, job and discovery history and
 * site. The inventory itself is not moved: it is the same cluster, and the
 * next discovery reads it whole. Then the other registration and its API
 * credential are removed.
 *
 * Everything the merge writes is in one transaction, refused while a job runs
 * against either, and only for registrations `sameProxmoxCluster` says are
 * one — merging two different clusters would drop one from Velnox.
 */

type Row = Awaited<ReturnType<ClusterMergeService['load']>>[number];

@Injectable()
export class ClusterMergeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly secrets: SecretStoreService,
    private readonly audit: AuditService,
  ) {}

  private load(where: { id?: { in: string[] } } = {}) {
    return this.prisma.client.cluster.findMany({
      where,
      select: {
        id: true,
        tenantId: true,
        siteId: true,
        name: true,
        endpointHost: true,
        endpointPort: true,
        pveClusterName: true,
        credentialId: true,
        sshCredentialId: true,
        sshUsername: true,
        sshPort: true,
        sshVerifiedAt: true,
        sshPublicKey: true,
        nodes: {
          select: { id: true, name: true, sshHostKeyFingerprint: true, sshHostKeyType: true },
        },
        updatePolicy: { select: { id: true } },
        placementSettings: { select: { clusterId: true } },
      },
      orderBy: { name: 'asc' },
    });
  }

  private static like(row: Row) {
    return {
      id: row.id,
      tenantId: row.tenantId,
      pveClusterName: row.pveClusterName,
      nodes: row.nodes.map((n) => n.name),
    };
  }

  /** The registrations this account may merge, grouped by the cluster they are. */
  async candidates(actor: Actor): Promise<ClusterMergeCandidate[]> {
    const rows = (await this.load()).filter((row) =>
      isAllowed(actor.grants, PERMISSIONS.clustersManage, {
        tenantId: row.tenantId,
        siteId: row.siteId,
        clusterId: row.id,
      }),
    );
    return mergeCandidates(rows.map((row) => ({ ...ClusterMergeService.like(row), row }))).map(
      (group) => {
        const [first, ...rest] = group;
        const shared = first!.nodes.filter((n) => rest.some((r) => r.nodes.includes(n)));
        return {
          pveClusterName: first!.pveClusterName!,
          clusters: group.map(({ row }) => ({
            id: row.id,
            name: row.name,
            endpoint: `${row.endpointHost}:${row.endpointPort}`,
            sshConfigured: row.sshCredentialId !== null,
            siteId: row.siteId,
          })),
          nodes: shared,
        };
      },
    );
  }

  async merge(input: ClusterMergeInput, actor: Actor) {
    const rows = await this.load({ id: { in: [input.keepId, input.removeId] } });
    const keep = rows.find((r) => r.id === input.keepId);
    const remove = rows.find((r) => r.id === input.removeId);
    if (!keep || !remove) throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });
    for (const row of [keep, remove]) {
      assertAllowedAt(actor, PERMISSIONS.clustersManage, {
        tenantId: row.tenantId,
        siteId: row.siteId,
        clusterId: row.id,
      });
    }

    if (!sameProxmoxCluster(ClusterMergeService.like(keep), ClusterMergeService.like(remove))) {
      throw new VelnoxError(ERROR_CODES.clusterMergeNotSame, {
        status: 409,
        params: { keep: keep.name, remove: remove.name },
      });
    }

    const busy = await this.prisma.client.job.count({
      where: {
        status: { in: [...ACTIVE_JOB_STATUSES] },
        OR: [
          { targetIds: { hasSome: [keep.id, remove.id] } },
          { concurrencyKey: { in: [`cluster:${keep.id}`, `cluster:${remove.id}`] } },
        ],
      },
    });
    if (busy > 0) {
      throw new VelnoxError(ERROR_CODES.clusterMergeBusy, { status: 409, params: { count: busy } });
    }

    // Whose SSH set-up stays: the one asked for, or whichever exists.
    const sshFromRemove =
      remove.sshCredentialId !== null &&
      (input.sshFrom === 'remove' || keep.sshCredentialId === null);
    const dropSsh = sshFromRemove ? keep.sshCredentialId : remove.sshCredentialId;

    // Host keys are facts about a node, not about a key: a node the kept
    // registration has not pinned takes the other's pin.
    const pinOf = new Map(
      remove.nodes
        .filter((n) => n.sshHostKeyFingerprint)
        .map((n) => [n.name, { fingerprint: n.sshHostKeyFingerprint, type: n.sshHostKeyType }]),
    );
    const takePins = keep.nodes.filter((n) => !n.sshHostKeyFingerprint && pinOf.has(n.name));

    const carried: string[] = [];
    if (sshFromRemove) carried.push('ssh');
    if (takePins.length) carried.push(`host keys (${takePins.map((n) => n.name).join(', ')})`);
    if (!keep.updatePolicy && remove.updatePolicy) carried.push('update policy');
    if (!keep.placementSettings && remove.placementSettings) carried.push('placement settings');
    if (!keep.siteId && remove.siteId) carried.push('site');
    // What the other had that the kept one already has its own of: said, not silently lost.
    const dropped: string[] = [];
    if (keep.sshCredentialId && remove.sshCredentialId)
      dropped.push(`SSH set-up of ${sshFromRemove ? keep.name : remove.name}`);
    if (keep.updatePolicy && remove.updatePolicy) dropped.push(`update policy of ${remove.name}`);
    if (keep.placementSettings && remove.placementSettings)
      dropped.push(`placement settings of ${remove.name}`);
    if (keep.siteId && remove.siteId && keep.siteId !== remove.siteId)
      dropped.push(`site of ${remove.name}`);

    const db = this.prisma.client;
    // Both registrations read the same Proxmox tasks; the kept one's copy stays.
    const keepUpids = (
      await db.proxmoxTask.findMany({ where: { clusterId: keep.id }, select: { upid: true } })
    ).map((t) => t.upid);
    const jobs = await db.job.findMany({
      where: { targetIds: { has: remove.id } },
      select: { id: true, targetIds: true },
    });
    await db.$transaction([
      // The kept registration: renamed, and given what it lacks.
      db.cluster.update({
        where: { id: keep.id },
        data: {
          name: input.name,
          siteId: keep.siteId ?? remove.siteId,
          ...(sshFromRemove
            ? {
                sshCredentialId: remove.sshCredentialId,
                sshUsername: remove.sshUsername,
                sshPort: remove.sshPort,
                sshVerifiedAt: remove.sshVerifiedAt,
                sshPublicKey: remove.sshPublicKey,
              }
            : {}),
        },
      }),
      ...takePins.map((node) =>
        db.node.update({
          where: { id: node.id },
          data: {
            sshHostKeyFingerprint: pinOf.get(node.name)!.fingerprint,
            sshHostKeyType: pinOf.get(node.name)!.type,
          },
        }),
      ),
      ...(sshFromRemove && remove.sshCredentialId
        ? [
            db.credential.update({
              where: { id: remove.sshCredentialId },
              data: { scopeId: keep.id, label: `${input.name} (SSH)` },
            }),
          ]
        : []),
      // What belongs to the cluster rather than to its inventory.
      ...(!keep.updatePolicy && remove.updatePolicy
        ? [
            db.updatePolicy.update({
              where: { id: remove.updatePolicy.id },
              data: { clusterId: keep.id },
            }),
          ]
        : []),
      ...(!keep.placementSettings && remove.placementSettings
        ? [
            db.placementSettings.update({
              where: { clusterId: remove.id },
              data: { clusterId: keep.id },
            }),
          ]
        : []),
      db.placementRule.updateMany({
        where: { clusterId: remove.id },
        data: { clusterId: keep.id },
      }),
      db.upgradePlan.updateMany({ where: { clusterId: remove.id }, data: { clusterId: keep.id } }),
      db.provisioning.updateMany({ where: { clusterId: remove.id }, data: { clusterId: keep.id } }),
      db.libraryItem.updateMany({
        where: { sourceClusterId: remove.id },
        data: { sourceClusterId: keep.id, sourceClusterName: input.name },
      }),
      // History: discovery runs, Proxmox tasks (both read the same ones), jobs.
      db.discoveryRun.updateMany({ where: { clusterId: remove.id }, data: { clusterId: keep.id } }),
      db.proxmoxTask.deleteMany({
        where: { clusterId: remove.id, upid: { in: keepUpids } },
      }),
      db.proxmoxTask.updateMany({ where: { clusterId: remove.id }, data: { clusterId: keep.id } }),
      ...jobs.map((job) =>
        db.job.update({
          where: { id: job.id },
          data: { targetIds: job.targetIds.map((id) => (id === remove.id ? keep.id : id)) },
        }),
      ),
      // The other registration, and with it its copy of the inventory.
      db.cluster.delete({ where: { id: remove.id } }),
    ]);

    // Secrets nobody owns any more: the other registration's API token, and
    // the SSH key that did not stay.
    for (const credentialId of [remove.credentialId, dropSsh]) {
      if (credentialId) await this.secrets.deleteCredential(credentialId).catch(() => undefined);
    }

    const metadata = {
      kept: keep.name,
      removed: remove.name,
      pveClusterName: keep.pveClusterName,
      carried: carried.join(', ') || 'nothing beyond its own',
      dropped: dropped.join(', ') || 'nothing',
    };
    for (const row of [keep, remove]) {
      await this.audit.success(AUDIT_ACTIONS.clusterMerged, {
        actorType: 'USER',
        actorId: actor.id,
        actorLabel: actor.email,
        tenantId: row.tenantId,
        resourceType: 'cluster',
        resourceId: row.id,
        resourceLabel: row.name,
        metadata: { ...metadata, into: input.name },
      });
    }

    await this.queue.enqueueInventory(JOB_NAMES.inventoryDiscover, {
      clusterId: keep.id,
      requestedBy: actor.id,
    });

    return { id: keep.id, name: input.name, carried, dropped };
  }
}

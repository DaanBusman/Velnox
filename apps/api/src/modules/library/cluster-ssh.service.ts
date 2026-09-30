import { Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  JOB_NAMES,
  PERMISSIONS,
  VelnoxError,
  type ClusterSshProbe,
} from '@velnox/shared';
import { PrismaService } from '../infrastructure/prisma.service';
import { QueueService } from '../infrastructure/queue.service';
import { SecretStoreService } from '../auth/secret-store.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { assertAllowedAt, type Actor } from '../../common/actor';

/**
 * SSH on a cluster, set up the way a cluster itself is added (ADR-038).
 *
 * **Probe** reads every node's host key and authenticates to none. **Configure**
 * takes the keys the operator confirmed, stores the private key encrypted, pins
 * the host keys per node, and then proves the key opens SFTP on every pinned
 * node. If any node refuses, everything this call stored is taken back out —
 * the previous set-up, if there was one, is left exactly as it was.
 *
 * The worker does the connecting (ADR-009); this waits for it.
 */

const PROBE_TIMEOUT_MS = 30_000;
const VERIFY_TIMEOUT_MS = 45_000;

export type ProbeResult = ClusterSshProbe;

export interface VerifyResult {
  nodes: { node: string; ok: boolean; error: string | null; code: string | null }[];
}

@Injectable()
export class ClusterSshService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly secrets: SecretStoreService,
    private readonly audit: AuditService,
  ) {}

  private async cluster(id: string) {
    const cluster = await this.prisma.client.cluster.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        tenantId: true,
        sshCredentialId: true,
        sshUsername: true,
        sshPort: true,
        sshVerifiedAt: true,
        nodes: {
          select: {
            id: true,
            name: true,
            address: true,
            sshHostKeyFingerprint: true,
            sshHostKeyType: true,
          },
          orderBy: { name: 'asc' },
        },
      },
    });
    if (!cluster) throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });
    return cluster;
  }

  async status(id: string) {
    const cluster = await this.cluster(id);
    return {
      configured: cluster.sshCredentialId !== null,
      username: cluster.sshUsername,
      port: cluster.sshPort,
      verifiedAt: cluster.sshVerifiedAt?.toISOString() ?? null,
      nodes: cluster.nodes.map((node) => ({
        node: node.name,
        address: node.address,
        fingerprint: node.sshHostKeyFingerprint,
        keyType: node.sshHostKeyType,
      })),
    };
  }

  async probe(id: string, port: number, actor: Actor): Promise<ProbeResult> {
    const cluster = await this.cluster(id);
    assertAllowedAt(actor, PERMISSIONS.clustersManage, {
      tenantId: cluster.tenantId,
      clusterId: cluster.id,
    });

    const result = await this.queue.runAndWait<ProbeResult>(
      JOB_NAMES.inventorySshProbe,
      { clusterId: cluster.id, port },
      PROBE_TIMEOUT_MS,
    );
    await this.audit.success(AUDIT_ACTIONS.clusterSshProbed, {
      actorType: 'USER',
      actorId: actor.id,
      actorLabel: actor.email,
      tenantId: cluster.tenantId,
      resourceType: 'cluster',
      resourceId: cluster.id,
      resourceLabel: cluster.name,
      // Host keys are public, and which ones were shown is the point.
      metadata: {
        port,
        keys: result.nodes.map((node) => `${node.node}=${node.fingerprint ?? 'none'}`),
      },
    });
    return result;
  }

  async configure(
    id: string,
    input: {
      username: string;
      port: number;
      privateKey: string;
      passphrase?: string | null;
      hostKeys: { node: string; fingerprint: string }[];
    },
    actor: Actor,
  ) {
    const cluster = await this.cluster(id);
    assertAllowedAt(actor, PERMISSIONS.clustersManage, {
      tenantId: cluster.tenantId,
      clusterId: cluster.id,
    });

    const byName = new Map(cluster.nodes.map((node) => [node.name, node]));
    for (const key of input.hostKeys) {
      if (!byName.has(key.node)) {
        throw new VelnoxError(ERROR_CODES.notFound, { status: 404, params: { node: key.node } });
      }
    }

    /*
     * Confirmed against what the nodes present now, not only against what the
     * form says. A key that changed between the probe and the confirm is either
     * a reinstall or an interception, and neither is the operator's to wave
     * through without seeing the new one.
     */
    const current = await this.queue.runAndWait<ProbeResult>(
      JOB_NAMES.inventorySshProbe,
      { clusterId: cluster.id, port: input.port },
      PROBE_TIMEOUT_MS,
    );
    for (const key of input.hostKeys) {
      const seen = current.nodes.find((node) => node.node === key.node);
      if (!seen?.fingerprint || seen.fingerprint !== key.fingerprint) {
        throw new VelnoxError(ERROR_CODES.sshHostKeyChanged, {
          status: 409,
          params: { node: key.node, presented: seen?.fingerprint ?? null },
        });
      }
    }
    const types = new Map(current.nodes.map((node) => [node.node, node.keyType]));

    const previous = {
      credentialId: cluster.sshCredentialId,
      username: cluster.sshUsername,
      port: cluster.sshPort,
      verifiedAt: cluster.sshVerifiedAt,
      pins: cluster.nodes.map((node) => ({
        id: node.id,
        fingerprint: node.sshHostKeyFingerprint,
        type: node.sshHostKeyType,
      })),
    };

    const { credentialId } = await this.secrets.putForCredential({
      kind: 'SSH_KEY',
      // One secret, so a key and its passphrase can never be rotated apart.
      material: JSON.stringify({
        privateKey: input.privateKey,
        passphrase: input.passphrase ?? '',
      }),
      tenantId: cluster.tenantId,
      label: `${cluster.name} (SSH)`,
      username: input.username,
      scopeType: 'CLUSTER',
      scopeId: cluster.id,
    });

    const pinned = new Map(input.hostKeys.map((key) => [key.node, key.fingerprint]));
    await this.prisma.client.$transaction([
      this.prisma.client.cluster.update({
        where: { id: cluster.id },
        data: {
          sshCredentialId: credentialId,
          sshUsername: input.username,
          sshPort: input.port,
          sshVerifiedAt: null,
        },
      }),
      ...cluster.nodes.map((node) =>
        this.prisma.client.node.update({
          where: { id: node.id },
          data: {
            sshHostKeyFingerprint: pinned.get(node.name) ?? null,
            sshHostKeyType: pinned.has(node.name) ? (types.get(node.name) ?? null) : null,
          },
        }),
      ),
    ]);

    const restore = async (): Promise<void> => {
      await this.prisma.client.$transaction([
        this.prisma.client.cluster.update({
          where: { id: cluster.id },
          data: {
            sshCredentialId: previous.credentialId,
            sshUsername: previous.username,
            sshPort: previous.port,
            sshVerifiedAt: previous.verifiedAt,
          },
        }),
        ...previous.pins.map((pin) =>
          this.prisma.client.node.update({
            where: { id: pin.id },
            data: { sshHostKeyFingerprint: pin.fingerprint, sshHostKeyType: pin.type },
          }),
        ),
      ]);
      await this.secrets.deleteCredential(credentialId);
    };

    let verified: VerifyResult;
    try {
      verified = await this.queue.runAndWait<VerifyResult>(
        JOB_NAMES.inventorySshVerify,
        { clusterId: cluster.id },
        VERIFY_TIMEOUT_MS,
      );
    } catch (error) {
      await restore();
      throw new VelnoxError(ERROR_CODES.sshUnreachable, { status: 502, cause: error });
    }

    const failed = verified.nodes.find((node) => !node.ok);
    if (failed) {
      await restore();
      throw new VelnoxError(failed.code ?? ERROR_CODES.sshUnreachable, {
        status: failed.code === ERROR_CODES.sshAuthFailed ? 401 : 502,
        params: { node: failed.node },
      });
    }

    await this.prisma.client.cluster.update({
      where: { id: cluster.id },
      data: { sshVerifiedAt: new Date() },
    });
    if (previous.credentialId && previous.credentialId !== credentialId) {
      await this.secrets.deleteCredential(previous.credentialId).catch(() => undefined);
    }

    await this.audit.success(AUDIT_ACTIONS.clusterSshConfigured, {
      actorType: 'USER',
      actorId: actor.id,
      actorLabel: actor.email,
      tenantId: cluster.tenantId,
      resourceType: 'cluster',
      resourceId: cluster.id,
      resourceLabel: cluster.name,
      metadata: {
        username: input.username,
        port: input.port,
        pinned: input.hostKeys.map((key) => `${key.node}=${key.fingerprint}`),
      },
    });

    return this.status(cluster.id);
  }

  async remove(id: string, actor: Actor): Promise<void> {
    const cluster = await this.cluster(id);
    assertAllowedAt(actor, PERMISSIONS.clustersManage, {
      tenantId: cluster.tenantId,
      clusterId: cluster.id,
    });
    if (!cluster.sshCredentialId) return;

    await this.prisma.client.$transaction([
      this.prisma.client.cluster.update({
        where: { id: cluster.id },
        data: { sshCredentialId: null, sshUsername: null, sshVerifiedAt: null },
      }),
      this.prisma.client.node.updateMany({
        where: { clusterId: cluster.id },
        data: { sshHostKeyFingerprint: null, sshHostKeyType: null },
      }),
    ]);
    await this.secrets.deleteCredential(cluster.sshCredentialId);

    await this.audit.success(AUDIT_ACTIONS.clusterSshRemoved, {
      actorType: 'USER',
      actorId: actor.id,
      actorLabel: actor.email,
      tenantId: cluster.tenantId,
      resourceType: 'cluster',
      resourceId: cluster.id,
      resourceLabel: cluster.name,
    });
  }
}

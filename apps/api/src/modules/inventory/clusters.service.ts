import { Injectable } from '@nestjs/common';
import type { ConnectionState, HealthState, ProxmoxAuthKind } from '@velnox/db';
import {
  ERROR_CODES,
  JOB_NAMES,
  PERMISSIONS,
  VelnoxError,
  normaliseFingerprint,
} from '@velnox/shared';
import { PrismaService } from '../infrastructure/prisma.service';
import { JobTimeoutError, QueueService } from '../infrastructure/queue.service';
import { SecretStoreService } from '../auth/secret-store.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { assertAllowedAt, type Actor } from '../../common/actor';

/**
 * Adding and keeping a Proxmox cluster.
 *
 * Two steps, and the split is the point.
 *
 * **Probe** connects to a host, reads its certificate and sends no credential.
 * An operator cannot confirm a fingerprint they have never been shown, and
 * showing it means connecting to a machine that is by definition not yet
 * trusted. What makes that acceptable is that nothing travels over the
 * connection.
 *
 * **Create** takes the fingerprint the operator confirmed, stores the token
 * encrypted, and only then authenticates — against the pinned certificate. So
 * the credential is never sent to a host nobody has vouched for.
 *
 * Neither step is performed here. ADR-009 keeps every outbound connection in the
 * worker; this enqueues and waits.
 */

export interface CertificateReport {
  fingerprint: string;
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  trustedByCa: boolean;
  /** Whether the host answered like a Proxmox API rather than a web server. */
  respondedAsProxmox: boolean;
}

export interface ClusterSummary {
  id: string;
  tenantId: string;
  tenantName: string;
  siteId: string | null;
  siteName: string | null;
  name: string;
  kind: 'CLUSTER' | 'STANDALONE';
  endpointHost: string;
  endpointPort: number;
  tlsFingerprint: string | null;
  authKind: ProxmoxAuthKind;
  authPrincipal: string | null;
  connectionState: ConnectionState;
  health: HealthState;
  pveVersion: string | null;
  pveVersions: string[];
  quorate: boolean | null;
  nodeCount: number;
  workloadCount: number;
  cephPresent: boolean;
  cephHealth: string | null;
  cephFlags: string[];
  cephVersionsHomogeneous: boolean | null;
  lastSeenAt: string | null;
  lastDiscoveryAt: string | null;
  lastErrorCode: string | null;
  lastErrorDetail: string | null;
  discoveryIntervalMinutes: number;
  createdAt: string;
}

export interface CreateClusterInput {
  tenantId: string;
  siteId?: string | null;
  name: string;
  host: string;
  port: number;
  fingerprint: string;
  auth:
    | { kind: 'API_TOKEN'; tokenId: string; secret: string }
    | { kind: 'TICKET'; username: string; realm: string; password: string };
}

/** How long a person will stand in front of a form waiting for a handshake. */
const PROBE_TIMEOUT_MS = 25_000;
const VERIFY_TIMEOUT_MS = 30_000;

@Injectable()
export class ClustersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly secrets: SecretStoreService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Look at a host's certificate, without authenticating.
   *
   * Requires `clusters.manage` somewhere. It is a connection to an arbitrary
   * address from inside the management network, which is worth a permission even
   * though it reveals nothing about Velnox.
   */
  async probe(input: { host: string; port: number }, actor: Actor): Promise<CertificateReport> {
    try {
      return await this.queue.runAndWait<CertificateReport>(
        JOB_NAMES.inventoryProbe,
        { host: input.host, port: input.port },
        PROBE_TIMEOUT_MS,
      );
    } catch (error) {
      await this.audit.failure(AUDIT_ACTIONS.clusterProbed, {
        actorType: 'USER',
        actorId: actor.id,
        actorLabel: actor.email,
        resourceType: 'cluster',
        resourceLabel: `${input.host}:${input.port}`,
      });
      throw translate(error, input.host);
    }
  }

  async list(filter: { tenantId?: string; siteId?: string }): Promise<ClusterSummary[]> {
    const clusters = await this.prisma.client.cluster.findMany({
      where: {
        ...(filter.tenantId ? { tenantId: filter.tenantId } : {}),
        ...(filter.siteId ? { siteId: filter.siteId } : {}),
      },
      include: {
        tenant: { select: { name: true } },
        site: { select: { name: true } },
        _count: { select: { workloads: true } },
      },
      orderBy: [{ name: 'asc' }],
    });

    return clusters.map((cluster) => describe(cluster));
  }

  async get(id: string): Promise<ClusterSummary> {
    const cluster = await this.prisma.client.cluster.findFirst({
      where: { id },
      include: {
        tenant: { select: { name: true } },
        site: { select: { name: true } },
        _count: { select: { workloads: true } },
      },
    });

    // Out of scope and not existing are the same 404: a different answer would
    // confirm that a cluster with this id exists somewhere.
    if (!cluster) throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });
    return describe(cluster);
  }

  async create(input: CreateClusterInput, actor: Actor): Promise<ClusterSummary> {
    assertAllowedAt(actor, PERMISSIONS.clustersManage, {
      tenantId: input.tenantId,
      siteId: input.siteId ?? null,
    });

    const fingerprint = normaliseFingerprint(input.fingerprint);

    const [tenant, site] = await Promise.all([
      this.prisma.client.tenant.findFirst({ where: { id: input.tenantId, deletedAt: null } }),
      input.siteId
        ? this.prisma.client.site.findFirst({ where: { id: input.siteId, deletedAt: null } })
        : Promise.resolve(null),
    ]);

    if (!tenant) throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });
    if (input.siteId && !site) throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });

    /*
     * A site in another tenant is refused here as well as by a database trigger.
     * The trigger is the guarantee; this is the explanation.
     */
    if (site && site.tenantId !== input.tenantId) {
      throw new VelnoxError(ERROR_CODES.authzTenantForbidden, {
        status: 409,
        params: { reason: 'site_in_other_tenant' },
      });
    }

    const duplicate = await this.prisma.client.cluster.findFirst({
      where: { tenantId: input.tenantId, endpointHost: input.host, endpointPort: input.port },
    });

    if (duplicate) {
      throw new VelnoxError(ERROR_CODES.clusterDuplicate, {
        status: 409,
        message: 'That endpoint is already registered for this tenant',
        params: { clusterId: duplicate.id, name: duplicate.name },
      });
    }

    /*
     * The credential is written before anything is proven.
     *
     * The alternative — authenticate first, store afterwards — means the token
     * travels to the worker inside a job payload, which puts it in Redis to
     * avoid putting it in Postgres. Stored first, the worker is handed an id.
     */
    const principal =
      input.auth.kind === 'API_TOKEN'
        ? input.auth.tokenId
        : `${input.auth.username}@${input.auth.realm}`;

    const { credentialId } = await this.secrets.putForCredential({
      kind: input.auth.kind === 'API_TOKEN' ? 'PVE_API_TOKEN' : 'PVE_PASSWORD',
      material: input.auth.kind === 'API_TOKEN' ? input.auth.secret : input.auth.password,
      tenantId: input.tenantId,
      label: `${input.name} (${input.host})`,
      username: principal,
      scopeType: 'TENANT',
      scopeId: input.tenantId,
    });

    const cluster = await this.prisma.client.cluster.create({
      data: {
        tenantId: input.tenantId,
        siteId: input.siteId ?? null,
        name: input.name.trim(),
        endpointHost: input.host.trim().toLowerCase(),
        endpointPort: input.port,
        tlsVerifyMode: 'PINNED_FINGERPRINT',
        tlsFingerprint: fingerprint,
        authKind: input.auth.kind,
        authPrincipal: principal,
        credentialId,
        connectionState: 'PENDING',
      },
    });

    await this.audit.success(AUDIT_ACTIONS.clusterAdded, {
      actorType: 'USER',
      actorId: actor.id,
      actorLabel: actor.email,
      tenantId: input.tenantId,
      resourceType: 'cluster',
      resourceId: cluster.id,
      resourceLabel: cluster.name,
      // The fingerprint is public and is the whole point of the record: an
      // auditor should be able to see which certificate was trusted, and when.
      metadata: {
        endpoint: `${cluster.endpointHost}:${cluster.endpointPort}`,
        fingerprint,
        authKind: cluster.authKind,
        principal,
      },
    });

    /*
     * Prove the credential works before telling anyone the cluster was added.
     *
     * A cluster that appears in the list and then silently fails every discovery
     * run is worse than a refusal at the moment of adding it — the operator has
     * moved on, and the first sign of trouble is stale inventory nobody is
     * looking at.
     */
    try {
      await this.queue.runAndWait(
        JOB_NAMES.inventoryVerify,
        { clusterId: cluster.id },
        VERIFY_TIMEOUT_MS,
      );
    } catch (error) {
      const translated = translate(error, cluster.endpointHost);
      await this.prisma.client.cluster.update({
        where: { id: cluster.id },
        data: {
          connectionState: 'FAILED',
          lastErrorCode: translated.code,
          lastErrorDetail: translated.message,
        },
      });
      throw translated;
    }

    // Verified. The full inventory takes longer than a request should, so it
    // runs on its own and the screen fills in.
    await this.queue.enqueueInventory(JOB_NAMES.inventoryDiscover, {
      clusterId: cluster.id,
      requestedBy: actor.id,
    });

    return this.get(cluster.id);
  }

  async update(
    id: string,
    input: { name?: string; siteId?: string | null; discoveryIntervalMinutes?: number },
    actor: Actor,
  ): Promise<ClusterSummary> {
    const cluster = await this.prisma.client.cluster.findFirst({ where: { id } });
    if (!cluster) throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });

    assertAllowedAt(actor, PERMISSIONS.clustersManage, {
      tenantId: cluster.tenantId,
      siteId: cluster.siteId,
      clusterId: cluster.id,
    });

    if (input.siteId) {
      const site = await this.prisma.client.site.findFirst({
        where: { id: input.siteId, deletedAt: null },
      });
      if (!site) throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });
      if (site.tenantId !== cluster.tenantId) {
        throw new VelnoxError(ERROR_CODES.authzTenantForbidden, {
          status: 409,
          params: { reason: 'site_in_other_tenant' },
        });
      }
    }

    await this.prisma.client.cluster.update({
      where: { id },
      data: {
        ...(input.name === undefined ? {} : { name: input.name.trim() }),
        ...(input.siteId === undefined ? {} : { siteId: input.siteId }),
        ...(input.discoveryIntervalMinutes === undefined
          ? {}
          : { discoveryIntervalMinutes: input.discoveryIntervalMinutes }),
      },
    });

    await this.audit.success(AUDIT_ACTIONS.clusterUpdated, {
      actorType: 'USER',
      actorId: actor.id,
      actorLabel: actor.email,
      tenantId: cluster.tenantId,
      resourceType: 'cluster',
      resourceId: cluster.id,
      resourceLabel: cluster.name,
      metadata: { fields: Object.keys(input).sort().join(',') },
    });

    return this.get(id);
  }

  /**
   * Stop managing a cluster.
   *
   * A real delete, not an archive. What is removed is Velnox's cache of somebody
   * else's infrastructure: the cluster is untouched, the audit trail is
   * unaffected, and keeping a hidden copy of inventory that will never refresh
   * again would serve nobody while reserving the endpoint against re-adding it.
   *
   * The stored credential goes with it. Leaving an encrypted Proxmox token
   * behind for a cluster nobody manages is a secret with no owner.
   */
  async remove(id: string, actor: Actor): Promise<{ id: string }> {
    const cluster = await this.prisma.client.cluster.findFirst({ where: { id } });
    if (!cluster) throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });

    assertAllowedAt(actor, PERMISSIONS.clustersManage, {
      tenantId: cluster.tenantId,
      siteId: cluster.siteId,
      clusterId: cluster.id,
    });

    const grants = await this.prisma.client.roleAssignment.count({
      where: { scopeType: 'CLUSTER', scopeId: id },
    });

    if (grants > 0) {
      throw new VelnoxError(ERROR_CODES.validation, {
        status: 409,
        message: 'Revoke the grants scoped to this cluster before removing it',
        params: { reason: 'cluster_has_grants', count: grants },
      });
    }

    await this.prisma.client.cluster.delete({ where: { id } });

    if (cluster.credentialId) {
      await this.secrets.deleteCredential(cluster.credentialId);
    }

    await this.audit.success(AUDIT_ACTIONS.clusterRemoved, {
      actorType: 'USER',
      actorId: actor.id,
      actorLabel: actor.email,
      tenantId: cluster.tenantId,
      resourceType: 'cluster',
      resourceId: cluster.id,
      resourceLabel: cluster.name,
      metadata: { endpoint: `${cluster.endpointHost}:${cluster.endpointPort}` },
    });

    return { id };
  }

  /** Ask for a discovery run now. Returns once it is queued, not once it is done. */
  async discover(id: string, actor: Actor): Promise<{ queued: boolean }> {
    const cluster = await this.prisma.client.cluster.findFirst({ where: { id } });
    if (!cluster) throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });

    assertAllowedAt(actor, PERMISSIONS.clustersRead, {
      tenantId: cluster.tenantId,
      siteId: cluster.siteId,
      clusterId: cluster.id,
    });

    await this.queue.enqueueInventory(JOB_NAMES.inventoryDiscover, {
      clusterId: id,
      requestedBy: actor.id,
    });

    return { queued: true };
  }

  /** The last few runs, so "when did this last work" is answerable. */
  async runs(id: string, limit = 10) {
    const runs = await this.prisma.client.discoveryRun.findMany({
      where: { clusterId: id },
      orderBy: [{ startedAt: 'desc' }],
      take: limit,
    });

    return runs.map((run) => ({
      id: run.id,
      state: run.state,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      durationMs: run.durationMs,
      nodesSeen: run.nodesSeen,
      workloadsSeen: run.workloadsSeen,
      problems: Array.isArray(run.problems) ? (run.problems as string[]) : [],
      errorCode: run.errorCode,
      errorDetail: run.errorDetail,
    }));
  }
}

/**
 * Turn a worker failure into a code the frontend can render.
 *
 * The worker reports a class name and a message; the API turns that into one of
 * the codes in the catalogue (ADR-019). A message is kept as `detail` because an
 * operator debugging a firewall wants the actual reason, but the code is what
 * the interface reads.
 */
function translate(error: unknown, host: string): VelnoxError {
  if (error instanceof JobTimeoutError) {
    return new VelnoxError(ERROR_CODES.clusterUnreachable, {
      status: 504,
      message: `${host} did not answer in time`,
      params: { host },
    });
  }

  const message = error instanceof Error ? error.message : String(error);

  if (/FingerprintMismatch/i.test(message)) {
    return new VelnoxError(ERROR_CODES.nodeFingerprintMismatch, {
      status: 409,
      message,
      params: { host },
    });
  }

  if (/ProxmoxAuthError|refused the credentials/i.test(message)) {
    return new VelnoxError(ERROR_CODES.clusterAuthFailed, {
      status: 401,
      message,
      params: { host },
    });
  }

  if (/not a Proxmox|data envelope|not JSON/i.test(message)) {
    return new VelnoxError(ERROR_CODES.clusterNotProxmox, {
      status: 502,
      message,
      params: { host },
    });
  }

  return new VelnoxError(ERROR_CODES.clusterUnreachable, {
    status: 502,
    message,
    params: { host },
  });
}

function describe(cluster: {
  id: string;
  tenantId: string;
  siteId: string | null;
  name: string;
  kind: string;
  endpointHost: string;
  endpointPort: number;
  tlsFingerprint: string | null;
  authKind: ProxmoxAuthKind;
  authPrincipal: string | null;
  connectionState: ConnectionState;
  health: HealthState;
  pveVersion: string | null;
  pveVersions: string[];
  quorate: boolean | null;
  nodeCount: number;
  cephPresent: boolean;
  cephHealth: string | null;
  cephFlags: string[];
  cephVersionsHomogeneous: boolean | null;
  lastSeenAt: Date | null;
  lastDiscoveryAt: Date | null;
  lastErrorCode: string | null;
  lastErrorDetail: string | null;
  discoveryIntervalMinutes: number;
  createdAt: Date;
  tenant: { name: string };
  site: { name: string } | null;
  _count: { workloads: number };
}): ClusterSummary {
  return {
    id: cluster.id,
    tenantId: cluster.tenantId,
    tenantName: cluster.tenant.name,
    siteId: cluster.siteId,
    siteName: cluster.site?.name ?? null,
    name: cluster.name,
    kind: cluster.kind === 'STANDALONE' ? 'STANDALONE' : 'CLUSTER',
    endpointHost: cluster.endpointHost,
    endpointPort: cluster.endpointPort,
    tlsFingerprint: cluster.tlsFingerprint,
    authKind: cluster.authKind,
    authPrincipal: cluster.authPrincipal,
    connectionState: cluster.connectionState,
    health: cluster.health,
    pveVersion: cluster.pveVersion,
    pveVersions: cluster.pveVersions,
    quorate: cluster.quorate,
    nodeCount: cluster.nodeCount,
    workloadCount: cluster._count.workloads,
    cephPresent: cluster.cephPresent,
    cephHealth: cluster.cephHealth,
    cephFlags: cluster.cephFlags,
    cephVersionsHomogeneous: cluster.cephVersionsHomogeneous,
    lastSeenAt: cluster.lastSeenAt?.toISOString() ?? null,
    lastDiscoveryAt: cluster.lastDiscoveryAt?.toISOString() ?? null,
    lastErrorCode: cluster.lastErrorCode,
    lastErrorDetail: cluster.lastErrorDetail,
    discoveryIntervalMinutes: cluster.discoveryIntervalMinutes,
    createdAt: cluster.createdAt.toISOString(),
  };
}

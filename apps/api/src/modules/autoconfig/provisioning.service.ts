import { Injectable } from '@nestjs/common';
import type { Prisma, Provisioning } from '@velnox/db';
import {
  ERROR_CODES,
  JOB_TYPES,
  PERMISSIONS,
  VelnoxError,
  generatePassword,
  hostnameProblem,
  isAllowed,
  requiredTemplateSecrets,
  templateSettingsSchema,
  type JobDetail,
  type ProvisionRequest,
  type ProvisioningSummary,
  type RevealedCredentials,
  type TemplateSecretKey,
  type TemplateSettings,
  type WindowsImageSummary,
} from '@velnox/shared';
import { PrismaService } from '../infrastructure/prisma.service';
import { SecretStoreService } from '../auth/secret-store.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { JobsService } from '../jobs/jobs.service';
import { assertAllowedAt, type Actor } from '../../common/actor';
import { TemplatesService } from './templates.service';

/** Where a build's job has got to; read for builds still under way. */
interface JobProgress {
  currentStep: string | null;
  progressPct: number | null;
}

/** How long a reveal's answer may stay on screen. The page clears it after. */
const REVEAL_DISPLAY_MS = 5 * 60_000;

/**
 * Asking for a VM, and what comes back.
 *
 * Everything that can be refused is refused here, before a job exists: the
 * permission on the cluster, whether the template is offered to that tenant
 * and complete, the hostname, the storage and the bridge from inventory, the
 * installer in the library and — for Windows — the edition in its image list.
 * The worker checks the node itself again before it creates anything; this
 * saves queueing a job that cannot succeed and gives the form a reason it can
 * show.
 *
 * The one secret created here is an encrypted record's password when the
 * template says it is shown once: generated, stored for the worker, and
 * returned in this response and never again. The VM's own passwords are
 * decided by the worker, which is what can read a template's fixed ones.
 */
@Injectable()
export class ProvisioningService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretStoreService,
    private readonly audit: AuditService,
    private readonly jobs: JobsService,
    private readonly templates: TemplatesService,
  ) {}

  async request(
    input: ProvisionRequest,
    actor: Actor,
  ): Promise<{
    provisioning: ProvisioningSummary;
    job: JobDetail;
    documentPassword: string | null;
  }> {
    const cluster = await this.prisma.client.cluster.findUnique({
      where: { id: input.clusterId },
      select: { id: true, name: true, tenantId: true },
    });
    if (!cluster) throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });
    assertAllowedAt(actor, PERMISSIONS.workloadsProvision, {
      tenantId: cluster.tenantId,
      clusterId: cluster.id,
    });

    // --- the template ---------------------------------------------------------
    const template = await this.templates.row(input.templateId);
    const root = await this.templates.mspRootId();
    if (!this.templates.offered(template, cluster.tenantId, root, actor)) {
      throw new VelnoxError(ERROR_CODES.autoconfigNotOffered, { status: 403 });
    }
    const parsed = templateSettingsSchema.safeParse(template.settings);
    if (!parsed.success) {
      throw new VelnoxError(ERROR_CODES.validation, {
        status: 409,
        message: 'The template no longer validates; open it and save it again',
      });
    }
    const settings = parsed.data as TemplateSettings;
    const refs = (template.secretRefs ?? {}) as Partial<Record<TemplateSecretKey, string>>;
    const missing = requiredTemplateSecrets(settings, template).filter((key) => !refs[key]);
    if (missing.length > 0) {
      throw new VelnoxError(ERROR_CODES.autoconfigIncomplete, {
        status: 409,
        params: { missing: missing.join(', ') },
      });
    }

    // --- the hostname ---------------------------------------------------------
    const hostname = input.hostname.trim();
    const problem = hostnameProblem(hostname, settings.family);
    if (problem) {
      throw new VelnoxError(ERROR_CODES.provisioningHostnameInvalid, {
        status: 400,
        params: { problem, max: settings.family === 'WINDOWS' ? 15 : 63 },
      });
    }
    const clash = await this.prisma.client.workload.findFirst({
      where: { clusterId: cluster.id, name: { equals: hostname, mode: 'insensitive' } },
      select: { vmid: true },
    });
    if (clash) {
      throw new VelnoxError(ERROR_CODES.provisioningHostnameTaken, {
        status: 409,
        params: { hostname, vmid: clash.vmid },
      });
    }

    // --- the node's storage and network, from inventory ------------------------
    const node = await this.prisma.client.node.findFirst({
      where: { clusterId: cluster.id, name: input.node },
      select: { id: true },
    });
    if (!node)
      throw new VelnoxError(ERROR_CODES.notFound, { status: 404, params: { node: input.node } });
    await this.assertStorage(node.id, input.diskStorage, 'images', input.node);
    // The answer or seed ISO goes on the media storage too, so it always needs
    // `iso`; a Linux cloud image also needs `import`.
    await this.assertStorage(node.id, input.mediaStorage, 'iso', input.node);
    if (settings.family === 'LINUX') {
      await this.assertStorage(node.id, input.mediaStorage, 'import', input.node);
    }
    const bridge = await this.prisma.client.nodeInterface.findFirst({
      where: { nodeId: node.id, name: input.bridge, type: { in: ['bridge', 'OVSBridge'] } },
      select: { id: true },
    });
    if (!bridge) {
      throw new VelnoxError(ERROR_CODES.provisioningBridgeUnknown, {
        status: 409,
        params: { bridge: input.bridge, node: input.node },
      });
    }

    // --- the media, from the library -------------------------------------------
    await this.assertMedia(settings);

    // --- mail --------------------------------------------------------------------
    if (input.notify) {
      const mail = await this.prisma.client.systemSettings.findUnique({
        where: { id: 1 },
        select: { smtpEnabled: true },
      });
      if (!mail?.smtpEnabled) {
        throw new VelnoxError(ERROR_CODES.mailNotConfigured, { status: 409 });
      }
    }

    // --- the record's password, when it is shown once ---------------------------
    let documentPassword: string | null = null;
    let documentCredentialId: string | null = null;
    if (
      template.credentialDelivery === 'ENCRYPTED_PDF' &&
      template.pdfPasswordSource === 'SHOWN_ONCE'
    ) {
      documentPassword = generatePassword(20);
      const stored = await this.secrets.putForCredential({
        kind: 'DOCUMENT_PASSWORD',
        material: documentPassword,
        tenantId: cluster.tenantId,
        label: `Installation record password for ${hostname}`,
        scopeType: 'CLUSTER',
        scopeId: cluster.id,
      });
      documentCredentialId = stored.credentialId;
    }

    const provisioning = await this.prisma.client.provisioning.create({
      data: {
        tenantId: cluster.tenantId,
        templateId: template.id,
        templateName: template.name,
        family: settings.family,
        templateSnapshot: settings as unknown as Prisma.InputJsonValue,
        clusterId: cluster.id,
        clusterName: cluster.name,
        node: input.node,
        diskStorage: input.diskStorage,
        mediaStorage: input.mediaStorage,
        bridge: input.bridge,
        vlan: input.vlan,
        hostname,
        network: input.network as unknown as Prisma.InputJsonValue,
        requestedById: actor.id,
        requestedByLabel: actor.email,
        requestedByEmail: input.notify ? actor.email : null,
        credentialDelivery: template.credentialDelivery,
        documentPasswordCredentialId: documentCredentialId,
        notify: input.notify,
      },
    });

    let job: JobDetail;
    try {
      job = await this.jobs.create(
        {
          tenantId: cluster.tenantId,
          type: JOB_TYPES.vmProvision,
          params: { provisioningId: provisioning.id },
          // Two builds of the same name on one cluster cannot both be right.
          concurrencyKey: `provision:${cluster.id}:${hostname.toLowerCase()}`,
          concurrencyLabel: `${hostname} on ${cluster.name}`,
          targetKind: 'cluster',
          targetIds: [cluster.id],
          parentJobId: null,
        },
        actor,
      );
    } catch (error) {
      // No job means nothing will ever build this; the record and the password go.
      await this.prisma.client.provisioning
        .delete({ where: { id: provisioning.id } })
        .catch(() => undefined);
      if (documentCredentialId) {
        await this.secrets.deleteCredential(documentCredentialId).catch(() => undefined);
      }
      throw error;
    }
    const saved = await this.prisma.client.provisioning.update({
      where: { id: provisioning.id },
      data: { jobId: job.id },
    });

    await this.audit.success(AUDIT_ACTIONS.provisioningRequested, {
      actorType: 'USER',
      actorId: actor.id,
      actorLabel: actor.email,
      tenantId: cluster.tenantId,
      resourceType: 'provisioning',
      resourceId: saved.id,
      resourceLabel: hostname,
      metadata: {
        cluster: cluster.name,
        node: input.node,
        template: template.name,
        family: settings.family,
        delivery: template.credentialDelivery,
      },
    });

    return { provisioning: this.summary(saved, job), job, documentPassword };
  }

  private async assertStorage(nodeId: string, name: string, content: string, node: string) {
    const storage = await this.prisma.client.nodeStorage.findFirst({
      where: { nodeId, name },
      select: { enabled: true, active: true, content: true },
    });
    if (!storage || !storage.enabled || !storage.active || !storage.content.includes(content)) {
      throw new VelnoxError(ERROR_CODES.provisioningStorageUnsuitable, {
        status: 409,
        params: { storage: name, node, content },
      });
    }
  }

  private async assertMedia(settings: TemplateSettings): Promise<void> {
    const needed: { filename: string; kind: 'ISO' | 'DISK_IMAGE' }[] =
      settings.family === 'WINDOWS'
        ? [
            { filename: settings.isoFilename, kind: 'ISO' },
            ...(settings.virtioIsoFilename
              ? [{ filename: settings.virtioIsoFilename, kind: 'ISO' as const }]
              : []),
          ]
        : [{ filename: settings.imageFilename, kind: 'DISK_IMAGE' }];

    for (const want of needed) {
      const item = await this.prisma.client.libraryItem.findFirst({
        where: { filename: { equals: want.filename, mode: 'insensitive' }, state: 'READY' },
        select: { kind: true, windowsImages: true },
      });
      if (!item) {
        throw new VelnoxError(ERROR_CODES.autoconfigMediaMissing, {
          status: 409,
          params: { filename: want.filename },
        });
      }
      if (item.kind !== want.kind) {
        throw new VelnoxError(ERROR_CODES.autoconfigMediaWrongKind, {
          status: 409,
          params: { filename: want.filename },
        });
      }
      // The edition is checked against the list read from the ISO, when there
      // is one. An ISO whose list could not be read is not refused here; the
      // template form said so when the edition was typed.
      if (settings.family === 'WINDOWS' && want.filename === settings.isoFilename) {
        const images = item.windowsImages as WindowsImageSummary[] | null;
        if (images && !images.some((image) => image.name === settings.imageName)) {
          throw new VelnoxError(ERROR_CODES.autoconfigEditionNotInIso, {
            status: 409,
            params: { edition: settings.imageName, filename: want.filename },
          });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async list(filter: { clusterId?: string }): Promise<ProvisioningSummary[]> {
    const rows = await this.prisma.client.provisioning.findMany({
      where: filter.clusterId ? { clusterId: filter.clusterId } : {},
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const jobs = await this.progressOf(rows);
    return rows.map((row) => this.summary(row, row.jobId ? jobs.get(row.jobId) : undefined));
  }

  async get(id: string): Promise<ProvisioningSummary> {
    const row = await this.row(id);
    const jobs = await this.progressOf([row]);
    return this.summary(row, row.jobId ? jobs.get(row.jobId) : undefined);
  }

  /**
   * Where the job of each build still under way has got to, so a list can show it
   * without the reader opening every job. Finished builds are not looked up: their
   * state says everything.
   */
  private async progressOf(rows: Provisioning[]): Promise<Map<string, JobProgress>> {
    const ids = rows
      .filter((row) => row.jobId !== null && (row.state === 'QUEUED' || row.state === 'RUNNING'))
      .map((row) => row.jobId as string);
    if (ids.length === 0) return new Map();
    const jobs = await this.prisma.client.job.findMany({
      where: { id: { in: ids } },
      select: { id: true, currentStep: true, progressPct: true },
    });
    return new Map(jobs.map((job) => [job.id, job]));
  }

  private async row(id: string): Promise<Provisioning> {
    const row = await this.prisma.client.provisioning.findUnique({ where: { id } });
    if (!row) throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });
    return row;
  }

  summary(row: Provisioning, job?: JobProgress): ProvisioningSummary {
    const underway = row.state === 'QUEUED' || row.state === 'RUNNING';
    const started = row.startedAt?.getTime() ?? null;
    const finished = row.finishedAt?.getTime() ?? null;
    return {
      id: row.id,
      tenantId: row.tenantId,
      templateId: row.templateId,
      templateName: row.templateName,
      family: row.family,
      clusterId: row.clusterId,
      clusterName: row.clusterName,
      node: row.node,
      vmid: row.vmid,
      hostname: row.hostname,
      state: row.state,
      jobId: row.jobId,
      currentStep: underway ? (job?.currentStep ?? null) : null,
      progressPct: underway ? (job?.progressPct ?? null) : null,
      addresses: row.addresses,
      requestedByLabel: row.requestedByLabel,
      startedAt: row.startedAt?.toISOString() ?? null,
      finishedAt: row.finishedAt?.toISOString() ?? null,
      durationSeconds: started && finished ? Math.round((finished - started) / 1000) : null,
      credentialDelivery: row.credentialDelivery,
      credentialsAvailable:
        row.credentialsCredentialId !== null &&
        (row.credentialsExpireAt === null || row.credentialsExpireAt > new Date()),
      notifiedAt: row.notifiedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      // Never the credentials, and never where they are stored.
      errorCode: row.errorCode,
      errorParams:
        (row.errorParams as Record<string, string | number | boolean | null> | null) ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // The reveal
  // -------------------------------------------------------------------------

  /**
   * The VM's passwords, to whoever may manage the cluster it is on.
   *
   * The break-glass the project rules allow: an explicit action, a permission
   * stronger than the one that built the VM, written to the audit trail before
   * the answer leaves, and an answer the page clears after five minutes. A
   * refused attempt is audited too.
   */
  async reveal(id: string, actor: Actor): Promise<RevealedCredentials> {
    const row = await this.row(id);
    const target = row.clusterId
      ? { tenantId: row.tenantId, clusterId: row.clusterId }
      : { tenantId: row.tenantId };
    if (!isAllowed(actor.grants, PERMISSIONS.clustersManage, target)) {
      await this.audit.denied(AUDIT_ACTIONS.provisioningCredentialsRevealed, {
        actorType: 'USER',
        actorId: actor.id,
        actorLabel: actor.email,
        tenantId: row.tenantId,
        resourceType: 'provisioning',
        resourceId: row.id,
        resourceLabel: row.hostname,
      });
      assertAllowedAt(actor, PERMISSIONS.clustersManage, target);
    }
    if (
      !row.credentialsCredentialId ||
      (row.credentialsExpireAt !== null && row.credentialsExpireAt <= new Date())
    ) {
      throw new VelnoxError(ERROR_CODES.provisioningCredentialsGone, { status: 410 });
    }

    const credential = await this.prisma.client.credentialSecret.findFirst({
      where: { credentialId: row.credentialsCredentialId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!credential)
      throw new VelnoxError(ERROR_CODES.provisioningCredentialsGone, { status: 410 });

    await this.audit.success(AUDIT_ACTIONS.provisioningCredentialsRevealed, {
      actorType: 'USER',
      actorId: actor.id,
      actorLabel: actor.email,
      tenantId: row.tenantId,
      resourceType: 'provisioning',
      resourceId: row.id,
      resourceLabel: row.hostname,
    });
    const material = await this.secrets.get(credential.id);
    const stored = JSON.parse(material.toString('utf8')) as {
      accounts: { name: string; password: string | null; administrator: boolean }[];
    };
    return {
      hostname: row.hostname,
      accounts: stored.accounts,
      expiresAt: new Date(Date.now() + REVEAL_DISPLAY_MS).toISOString(),
    };
  }
}

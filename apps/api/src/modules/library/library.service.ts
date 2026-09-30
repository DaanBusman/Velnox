import { Inject, Injectable } from '@nestjs/common';
import { createWriteStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type { ApiConfig } from '@velnox/config';
import {
  ensureLibraryDirs,
  libraryPaths,
  readLibraryCapacity,
  type LibraryLimits,
  type LibraryPaths,
  type Prisma,
} from '@velnox/db';
import {
  ACTIVE_JOB_STATUSES,
  ERROR_CODES,
  JOB_TYPES,
  PERMISSIONS,
  VelnoxError,
  checkCapacity,
  contentTypeFor,
  displayUrl,
  isValidLibraryFilename,
  kindForFilename,
  locationKeyFor,
  parseVolumeId,
  type JobDetail,
  type LibraryCapacitySummary,
  type LibraryItemSummary,
  type WindowsImageSummary,
} from '@velnox/shared';
import { API_CONFIG } from '../../config/config.module';
import { PrismaService } from '../infrastructure/prisma.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { JobsService } from '../jobs/jobs.service';
import { assertAllowedAt, type Actor } from '../../common/actor';

/**
 * The ISO library, from the API's side.
 *
 * The API decides and records; the worker moves bytes (ADR-009). The one
 * exception is a browser upload, whose chunks arrive here and are written here
 * — the API is where the browser's connection ends, and relaying gigabytes
 * through Redis to the worker would be the long way round. Checking the
 * finished upload is still the worker's, as a job.
 */

/** The largest chunk one request may carry. The browser sends 32 MiB. */
export const UPLOAD_CHUNK_MAX = 64 * 1024 * 1024;
export const UPLOAD_CHUNK_PREFERRED = 32 * 1024 * 1024;

type ItemRow = Prisma.LibraryItemGetPayload<object>;

const flatParams = (value: unknown): Record<string, string | number | boolean | null> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, string | number | boolean | null>)
    : null;

function describe(item: ItemRow): LibraryItemSummary {
  return {
    id: item.id,
    kind: item.kind,
    state: item.state,
    source: item.source,
    filename: item.filename,
    sizeBytes: item.sizeBytes === null ? null : Number(item.sizeBytes),
    receivedBytes: Number(item.receivedBytes),
    sha256: item.sha256,
    diskFormat: item.diskFormat,
    titleOverride: item.titleOverride,
    languageOverride: item.languageOverride,
    sourceUrl: item.sourceUrl ? displayUrl(item.sourceUrl) : null,
    sourceClusterName: item.sourceClusterName,
    sourceVolid: item.sourceVolid,
    jobId: item.jobId,
    createdBy: item.createdByLabel,
    errorCode: item.errorCode,
    errorParams: flatParams(item.errorParams),
    createdAt: item.createdAt.toISOString(),
    readyAt: item.readyAt?.toISOString() ?? null,
    windowsImages: (item.windowsImages as WindowsImageSummary[] | null) ?? null,
  };
}

@Injectable()
export class LibraryService {
  private readonly limits: LibraryLimits;
  private readonly paths: LibraryPaths;
  private dirsReady: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly audit: AuditService,
    @Inject(API_CONFIG) config: ApiConfig,
  ) {
    this.limits = {
      dir: config.VELNOX_LIBRARY_DIR,
      maxGb: config.VELNOX_LIBRARY_MAX_GB,
      minFreeGb: config.VELNOX_LIBRARY_MIN_FREE_GB,
    };
    this.paths = libraryPaths(this.limits.dir);
  }

  private ensureDirs(): Promise<void> {
    this.dirsReady ??= ensureLibraryDirs(this.limits.dir);
    return this.dirsReady;
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async list(): Promise<{ items: LibraryItemSummary[]; capacity: LibraryCapacitySummary }> {
    const [items, capacity] = await Promise.all([
      this.prisma.client.libraryItem.findMany({ orderBy: [{ createdAt: 'desc' }] }),
      this.capacity(),
    ]);
    return { items: items.map(describe), capacity };
  }

  async get(id: string): Promise<LibraryItemSummary> {
    return describe(await this.row(id));
  }

  async capacity(excludeItemId?: string): Promise<LibraryCapacitySummary> {
    await this.ensureDirs();
    const capacity = await readLibraryCapacity(this.prisma.client, this.limits, excludeItemId);
    return { ...capacity, maxGb: this.limits.maxGb, minFreeGb: this.limits.minFreeGb };
  }

  private async row(id: string): Promise<ItemRow> {
    const item = await this.prisma.client.libraryItem.findUnique({ where: { id } });
    if (!item) throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });
    return item;
  }

  // -------------------------------------------------------------------------
  // Adding
  // -------------------------------------------------------------------------

  /** `library.manage` is checked against the MSP root: the library is nobody else's. */
  private async assertManage(actor: Actor): Promise<string> {
    const root = await this.prisma.client.tenant.findFirst({
      where: { kind: 'MSP_ROOT' },
      select: { id: true },
    });
    if (!root) throw new VelnoxError(ERROR_CODES.authzForbidden, { status: 403 });
    assertAllowedAt(actor, PERMISSIONS.libraryManage, { tenantId: root.id });
    return root.id;
  }

  private assertFilename(filename: string) {
    if (!isValidLibraryFilename(filename)) {
      throw new VelnoxError(ERROR_CODES.libraryInvalidFilename, {
        status: 400,
        params: { filename },
      });
    }
    const kind = kindForFilename(filename);
    if (!kind)
      throw new VelnoxError(ERROR_CODES.libraryUnsupportedKind, {
        status: 400,
        params: { filename },
      });
    return kind;
  }

  private async assertFreeName(filename: string): Promise<void> {
    const taken = await this.prisma.client.libraryItem.findFirst({
      where: { filename: { equals: filename, mode: 'insensitive' }, state: { not: 'FAILED' } },
      select: { id: true },
    });
    if (taken) {
      throw new VelnoxError(ERROR_CODES.libraryDuplicateFilename, {
        status: 409,
        params: { filename, itemId: taken.id },
      });
    }
  }

  private async assertCapacity(bytes: number): Promise<void> {
    const refusal = checkCapacity(await this.capacity(), bytes);
    if (refusal) throw new VelnoxError(refusal.code, { status: 409, params: refusal.params });
  }

  /** Two items racing for one name: the database's unique index decides. */
  private async createItem(data: Prisma.LibraryItemCreateInput): Promise<ItemRow> {
    try {
      return await this.prisma.client.libraryItem.create({ data });
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'P2002') {
        throw new VelnoxError(ERROR_CODES.libraryDuplicateFilename, {
          status: 409,
          params: { filename: data.filename },
        });
      }
      throw error;
    }
  }

  private async added(item: ItemRow, actor: Actor, tenantId: string, how: string): Promise<void> {
    await this.audit.success(AUDIT_ACTIONS.libraryItemAdded, {
      actorType: 'USER',
      actorId: actor.id,
      actorLabel: actor.email,
      tenantId,
      resourceType: 'library_item',
      resourceId: item.id,
      resourceLabel: item.filename,
      metadata: {
        how,
        ...(item.sourceUrl ? { url: displayUrl(item.sourceUrl) } : {}),
        ...(item.sourceVolid ? { volid: item.sourceVolid, cluster: item.sourceClusterName } : {}),
      },
    });
  }

  /**
   * Fetch a URL into the library.
   *
   * Validated here so a bad address is a refusal at the form rather than a
   * failed job a minute later: http or https, no credentials, a filename that
   * Proxmox will not rewrite. Where the address *points* is the worker's to
   * judge, because only the worker resolves it (address-guard.ts).
   */
  async addFromUrl(input: { url: string; filename?: string | null }, actor: Actor) {
    const tenantId = await this.assertManage(actor);

    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw new VelnoxError(ERROR_CODES.libraryUrlRefused, {
        status: 400,
        params: { reason: 'invalid' },
      });
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new VelnoxError(ERROR_CODES.libraryUrlRefused, {
        status: 400,
        params: { reason: 'scheme' },
      });
    }
    if (url.username || url.password) {
      throw new VelnoxError(ERROR_CODES.libraryUrlRefused, {
        status: 400,
        params: { reason: 'credentials' },
      });
    }

    const filename =
      input.filename?.trim() || decodeURIComponent(url.pathname.split('/').pop() ?? '');
    const kind = this.assertFilename(filename);
    await this.assertFreeName(filename);
    // The size is not known until the server answers; this refuses only a
    // library that is already at a limit. The worker checks again with the size.
    await this.assertCapacity(0);

    const item = await this.createItem({
      kind,
      source: 'URL',
      filename,
      sourceUrl: url.href,
      createdById: actor.id,
      createdByLabel: actor.email,
    });

    const job = await this.startJob(item, JOB_TYPES.libraryFetch, tenantId, actor);
    await this.added(item, actor, tenantId, 'url');
    return { item: await this.get(item.id), job };
  }

  /** Create the job, and point the item at it so the sweeper can find it. */
  private async startJob(
    item: ItemRow,
    type: string,
    tenantId: string,
    actor: Actor,
  ): Promise<JobDetail> {
    let job: JobDetail;
    try {
      job = await this.jobs.create(
        {
          tenantId,
          type,
          params: { itemId: item.id },
          concurrencyKey: `library-item:${item.id}`,
          concurrencyLabel: item.filename,
          targetKind: 'library_item',
          targetIds: [item.id],
          parentJobId: null,
        },
        actor,
      );
    } catch (error) {
      // No job means nothing will ever fill this item. It goes, rather than
      // sitting in RECEIVING looking like a transfer that is about to start.
      await this.prisma.client.libraryItem
        .delete({ where: { id: item.id } })
        .catch(() => undefined);
      throw error;
    }
    await this.prisma.client.libraryItem.update({
      where: { id: item.id },
      data: { jobId: job.id },
    });
    return job;
  }

  // -------------------------------------------------------------------------
  // Browser uploads
  // -------------------------------------------------------------------------

  async startUpload(input: { filename: string; sizeBytes: number }, actor: Actor) {
    const tenantId = await this.assertManage(actor);
    const kind = this.assertFilename(input.filename);
    await this.assertFreeName(input.filename);
    await this.assertCapacity(input.sizeBytes);
    await this.ensureDirs();

    const item = await this.createItem({
      kind,
      source: 'UPLOAD',
      filename: input.filename,
      sizeBytes: BigInt(input.sizeBytes),
      createdById: actor.id,
      createdByLabel: actor.email,
    });
    // Created empty now, so every chunk — the first included — is a write at a
    // position into a file that exists, and a resumed upload is the same code.
    const handle = await open(this.paths.partial(item.id), 'w');
    await handle.close();

    await this.added(item, actor, tenantId, 'upload');
    return { item: describe(item), chunkBytes: UPLOAD_CHUNK_PREFERRED };
  }

  private async uploadRow(id: string, actor: Actor): Promise<ItemRow> {
    await this.assertManage(actor);
    const item = await this.row(id);
    if (item.source !== 'UPLOAD') throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });
    return item;
  }

  /** Where an upload is up to, for a browser resuming after a dropped connection. */
  async uploadStatus(id: string, actor: Actor) {
    return describe(await this.uploadRow(id, actor));
  }

  /**
   * Write one chunk at `offset`.
   *
   * The offset must be exactly where the upload is up to. A chunk for any
   * other position is refused with the right one, which is how a browser that
   * lost track resynchronises. The counter only moves if nobody else moved it
   * first — two requests carrying the same chunk write the same bytes to the
   * same place, and exactly one of them advances it.
   */
  async writeChunk(
    id: string,
    offset: number,
    declaredLength: number,
    body: Readable,
    actor: Actor,
  ): Promise<{ item: LibraryItemSummary; job: JobDetail | null }> {
    const item = await this.uploadRow(id, actor);
    const size = Number(item.sizeBytes ?? 0);
    const received = Number(item.receivedBytes);

    if (item.state !== 'RECEIVING') {
      throw new VelnoxError(ERROR_CODES.libraryNotReady, {
        status: 409,
        params: { state: item.state },
      });
    }
    if (offset !== received) {
      throw new VelnoxError(ERROR_CODES.libraryUploadOffset, {
        status: 409,
        params: { expected: received, got: offset },
      });
    }
    if (
      declaredLength <= 0 ||
      declaredLength > UPLOAD_CHUNK_MAX ||
      offset + declaredLength > size
    ) {
      throw new VelnoxError(ERROR_CODES.libraryUploadTooLarge, {
        status: 413,
        params: { maxChunkBytes: UPLOAD_CHUNK_MAX, remainingBytes: size - offset },
      });
    }

    let written = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        written += chunk.length;
        if (written > declaredLength) {
          callback(new VelnoxError(ERROR_CODES.libraryUploadTooLarge, { status: 413 }));
          return;
        }
        callback(null, chunk);
      },
    });
    await pipeline(
      body,
      limit,
      createWriteStream(this.paths.partial(id), { flags: 'r+', start: offset }),
    );

    if (written !== declaredLength) {
      // The connection dropped part-way. Nothing is counted; the browser sends
      // this chunk again from the same offset, over the same bytes.
      throw new VelnoxError(ERROR_CODES.librarySizeMismatch, {
        status: 400,
        params: { expected: declaredLength, got: written },
      });
    }

    const next = offset + written;
    const advanced = await this.prisma.client.libraryItem.updateMany({
      where: { id, state: 'RECEIVING', receivedBytes: BigInt(offset) },
      data: { receivedBytes: BigInt(next), ...(next === size ? { state: 'VERIFYING' } : {}) },
    });

    let job: JobDetail | null = null;
    if (advanced.count === 1 && next === size) {
      const root = await this.assertManage(actor);
      job = await this.startJob(await this.row(id), JOB_TYPES.libraryVerify, root, actor);
    }
    return { item: await this.get(id), job };
  }

  async abandonUpload(id: string, actor: Actor): Promise<void> {
    const item = await this.uploadRow(id, actor);
    if (item.state !== 'RECEIVING') {
      throw new VelnoxError(ERROR_CODES.libraryNotReady, {
        status: 409,
        params: { state: item.state },
      });
    }
    await rm(this.paths.partial(id), { force: true });
    await this.prisma.client.libraryItem.deleteMany({ where: { id, state: 'RECEIVING' } });
    await this.audit.success(AUDIT_ACTIONS.libraryUploadAbandoned, {
      actorType: 'USER',
      actorId: actor.id,
      actorLabel: actor.email,
      resourceType: 'library_item',
      resourceId: id,
      resourceLabel: item.filename,
    });
  }

  // -------------------------------------------------------------------------
  // Changing and removing
  // -------------------------------------------------------------------------

  async rename(
    id: string,
    input: { title?: string | null; language?: string | null },
    actor: Actor,
  ): Promise<LibraryItemSummary> {
    await this.assertManage(actor);
    const item = await this.row(id);
    const data: Prisma.LibraryItemUpdateInput = {};
    if (input.title !== undefined) data.titleOverride = input.title?.trim() || null;
    if (input.language !== undefined) data.languageOverride = input.language;
    await this.prisma.client.libraryItem.update({ where: { id }, data });
    await this.audit.success(AUDIT_ACTIONS.libraryItemRenamed, {
      actorType: 'USER',
      actorId: actor.id,
      actorLabel: actor.email,
      resourceType: 'library_item',
      resourceId: id,
      resourceLabel: item.filename,
      metadata: { title: input.title ?? null, language: input.language ?? null },
    });
    return this.get(id);
  }

  /**
   * Remove an item and its bytes.
   *
   * Refused while any job is using it — writing it, or pushing it somewhere —
   * because deleting the file under a push would fail that push halfway on a
   * customer's node.
   */
  async remove(id: string, actor: Actor): Promise<void> {
    const tenantId = await this.assertManage(actor);
    const item = await this.row(id);

    /*
     * Built from what is known, never with an `undefined` in it: Prisma reads
     * `{ id: undefined }` as no condition at all, and an OR with an empty branch
     * matches every active job in the installation.
     */
    const usedBy: Prisma.JobWhereInput[] = [{ params: { path: ['itemId'], equals: id } }];
    if (item.jobId) usedBy.push({ id: item.jobId });
    const using = await this.prisma.client.job.findFirst({
      where: { status: { in: [...ACTIVE_JOB_STATUSES] }, OR: usedBy },
      select: { id: true },
    });
    if (using) {
      throw new VelnoxError(ERROR_CODES.libraryInUse, { status: 409, params: { jobId: using.id } });
    }

    await rm(this.paths.item(id), { force: true });
    await rm(this.paths.partial(id), { force: true });
    await this.prisma.client.libraryItem.delete({ where: { id } });
    await this.audit.success(AUDIT_ACTIONS.libraryItemRemoved, {
      actorType: 'USER',
      actorId: actor.id,
      actorLabel: actor.email,
      tenantId,
      resourceType: 'library_item',
      resourceId: id,
      resourceLabel: item.filename,
      metadata: {
        sha256: item.sha256,
        sizeBytes: item.sizeBytes === null ? null : Number(item.sizeBytes),
      },
    });
  }

  // -------------------------------------------------------------------------
  // Moving files between the library and clusters
  // -------------------------------------------------------------------------

  private async clusterInScope(clusterId: string) {
    // Through the scoped client: a cluster outside the caller's tenants is the
    // same 404 as one that does not exist.
    const cluster = await this.prisma.client.cluster.findUnique({
      where: { id: clusterId },
      select: { id: true, name: true, tenantId: true, sshCredentialId: true },
    });
    if (!cluster) throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });
    return cluster;
  }

  async push(
    input: { itemId: string; clusterId: string; node: string; storage: string },
    actor: Actor,
  ) {
    const item = await this.row(input.itemId);
    if (item.state !== 'READY') {
      throw new VelnoxError(ERROR_CODES.libraryNotReady, {
        status: 409,
        params: { state: item.state },
      });
    }
    const cluster = await this.clusterInScope(input.clusterId);
    assertAllowedAt(actor, PERMISSIONS.clustersManage, {
      tenantId: cluster.tenantId,
      clusterId: cluster.id,
    });

    // A quick refusal from inventory. The worker checks the node itself before
    // it sends a byte; this only saves queueing a job that cannot succeed.
    const storage = await this.prisma.client.nodeStorage.findFirst({
      where: { name: input.storage, node: { clusterId: cluster.id, name: input.node } },
      select: { content: true, shared: true, active: true, enabled: true },
    });
    const content = contentTypeFor(item.kind);
    if (!storage || !storage.active || !storage.enabled || !storage.content.includes(content)) {
      throw new VelnoxError(ERROR_CODES.libraryStorageUnsuitable, {
        status: 409,
        params: { storage: input.storage, node: input.node, content },
      });
    }

    return this.jobs.create(
      {
        tenantId: cluster.tenantId,
        type: JOB_TYPES.libraryPush,
        params: {
          itemId: item.id,
          clusterId: cluster.id,
          node: input.node,
          storage: input.storage,
        },
        // One push of one file to one place at a time. Not the whole cluster:
        // an hour-long ISO copy must not block a node's updates.
        concurrencyKey: `library-push:${cluster.id}:${locationKeyFor(input.node, input.storage, storage.shared)}:${item.filename.toLowerCase()}`,
        concurrencyLabel: `${item.filename} → ${cluster.name}`,
        targetKind: 'cluster',
        targetIds: [cluster.id],
        parentJobId: null,
      },
      actor,
    );
  }

  /** What discovery last saw on a cluster's storage, and which of it the library already has. */
  async clusterContents(clusterId: string) {
    const cluster = await this.clusterInScope(clusterId);
    const [rows, items] = await Promise.all([
      this.prisma.client.storageContent.findMany({
        where: { clusterId: cluster.id },
        orderBy: [{ storage: 'asc' }, { volid: 'asc' }],
      }),
      this.prisma.client.libraryItem.findMany({
        where: { state: 'READY' },
        select: { id: true, filename: true, sizeBytes: true },
      }),
    ]);
    const byName = new Map(items.map((item) => [item.filename.toLowerCase(), item]));

    return {
      sshConfigured: cluster.sshCredentialId !== null,
      contents: rows.map((row) => {
        const filename = parseVolumeId(row.volid)?.filename ?? row.volid;
        const match = byName.get(filename.toLowerCase());
        return {
          id: row.id,
          node: row.nodeName,
          storage: row.storage,
          shared: row.shared,
          volid: row.volid,
          filename,
          content: row.content as 'iso' | 'import',
          format: row.format,
          sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
          fileCreatedAt: row.fileCreatedAt?.toISOString() ?? null,
          lastSeenAt: row.lastSeenAt.toISOString(),
          /** Same name and same size: almost certainly the same file, not provably. */
          libraryItemId:
            match && (row.sizeBytes === null || match.sizeBytes === row.sizeBytes)
              ? match.id
              : null,
        };
      }),
    };
  }

  private async contentRow(input: {
    clusterId: string;
    node: string;
    storage: string;
    volid: string;
  }) {
    const row = await this.prisma.client.storageContent.findFirst({
      where: { clusterId: input.clusterId, storage: input.storage, volid: input.volid },
      select: { nodeName: true, shared: true, sizeBytes: true, content: true },
    });
    if (!row || (!row.shared && row.nodeName !== input.node)) {
      throw new VelnoxError(ERROR_CODES.libraryNotOnStorage, {
        status: 404,
        params: { volid: input.volid },
      });
    }
    return row;
  }

  async deleteOnCluster(
    input: { clusterId: string; node: string; storage: string; volid: string },
    actor: Actor,
  ) {
    const cluster = await this.clusterInScope(input.clusterId);
    assertAllowedAt(actor, PERMISSIONS.clustersManage, {
      tenantId: cluster.tenantId,
      clusterId: cluster.id,
    });
    const row = await this.contentRow(input);

    return this.jobs.create(
      {
        tenantId: cluster.tenantId,
        type: JOB_TYPES.libraryClusterDelete,
        params: {
          clusterId: cluster.id,
          node: input.node,
          storage: input.storage,
          volid: input.volid,
        },
        concurrencyKey: `library-volume:${cluster.id}:${locationKeyFor(input.node, input.storage, row.shared)}:${input.volid}`,
        concurrencyLabel: `${input.volid} on ${cluster.name}`,
        targetKind: 'cluster',
        targetIds: [cluster.id],
        parentJobId: null,
      },
      actor,
    );
  }

  async pull(
    input: { clusterId: string; node: string; storage: string; volid: string },
    actor: Actor,
  ) {
    const libraryTenant = await this.assertManage(actor);
    const cluster = await this.clusterInScope(input.clusterId);
    assertAllowedAt(actor, PERMISSIONS.clustersManage, {
      tenantId: cluster.tenantId,
      clusterId: cluster.id,
    });
    if (!cluster.sshCredentialId) {
      throw new VelnoxError(ERROR_CODES.sshNotConfigured, {
        status: 409,
        params: { node: input.node },
      });
    }

    const row = await this.contentRow(input);
    const parsed = parseVolumeId(input.volid);
    if (!parsed) throw new VelnoxError(ERROR_CODES.libraryInvalidFilename, { status: 400 });
    const kind = this.assertFilename(parsed.filename);
    await this.assertFreeName(parsed.filename);
    await this.assertCapacity(row.sizeBytes === null ? 0 : Number(row.sizeBytes));

    const item = await this.createItem({
      kind,
      source: 'CLUSTER',
      filename: parsed.filename,
      sizeBytes: row.sizeBytes,
      sourceClusterId: cluster.id,
      sourceClusterName: cluster.name,
      sourceVolid: input.volid,
      createdById: actor.id,
      createdByLabel: actor.email,
    });

    let job: JobDetail;
    try {
      job = await this.jobs.create(
        {
          tenantId: cluster.tenantId,
          type: JOB_TYPES.libraryPull,
          params: {
            itemId: item.id,
            clusterId: cluster.id,
            node: input.node,
            storage: input.storage,
            volid: input.volid,
          },
          concurrencyKey: `library-item:${item.id}`,
          concurrencyLabel: parsed.filename,
          targetKind: 'cluster',
          targetIds: [cluster.id],
          parentJobId: null,
        },
        actor,
      );
    } catch (error) {
      await this.prisma.client.libraryItem
        .delete({ where: { id: item.id } })
        .catch(() => undefined);
      throw error;
    }
    await this.prisma.client.libraryItem.update({
      where: { id: item.id },
      data: { jobId: job.id },
    });
    await this.added(item, actor, libraryTenant, 'cluster');
    return { item: await this.get(item.id), job };
  }
}

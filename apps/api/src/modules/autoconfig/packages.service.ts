import { Inject, Injectable } from '@nestjs/common';
import { createWriteStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ApiConfig } from '@velnox/config';
import {
  ensureLibraryDirs,
  libraryPaths,
  readLibraryCapacity,
  withSystemScope,
  type LibraryPaths,
  type Prisma,
} from '@velnox/db';
import {
  ERROR_CODES,
  JOB_TYPES,
  PACKAGE_MAX_BYTES,
  PERMISSIONS,
  VelnoxError,
  checkCapacity,
  isAllowed,
  isValidPackageFilename,
  packageKindForFilename,
  type JobDetail,
  type PackageSummary,
  type TemplateSettings,
} from '@velnox/shared';
import { API_CONFIG } from '../../config/config.module';
import { PrismaService } from '../infrastructure/prisma.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { JobsService } from '../jobs/jobs.service';
import { assertAllowedAt, type Actor } from '../../common/actor';
import { UPLOAD_CHUNK_MAX, UPLOAD_CHUNK_PREFERRED } from '../library/library.service';

/**
 * Installer packages: MSIs and EXEs a tenant uploads, run in its Windows VMs
 * after Setup (Phase 5C).
 *
 * **A tenant's own.** Unlike the ISO library, which is installation-wide, a
 * package belongs to one tenant and the tenancy filter shows it to nobody else.
 * Reading needs `autoconfig.read` at that tenant, adding and removing
 * `autoconfig.manage`. A template may run only packages of the tenant that owns
 * it — checked here when it is saved, and again when a VM is requested — so an
 * MSP template carries the MSP's packages to a customer's VM without the
 * customer ever being able to list or download them.
 *
 * Uploads use the library's protocol, chunk for chunk, and the bytes live
 * beside the library's and count against its ceiling. Checking a finished
 * upload is the worker's, as a job in the tenant's name.
 */

type PackageRow = Prisma.AutoconfigPackageGetPayload<{
  include: { tenant: { select: { name: true } } };
}>;

@Injectable()
export class PackagesService {
  private readonly paths: LibraryPaths;
  private readonly limits: { dir: string; maxGb: number; minFreeGb: number };
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

  /** The tenants whose packages this actor may read: `autoconfig.read` there. */
  private readable(actor: Actor, tenantId?: string): string[] | null {
    if (tenantId) {
      assertAllowedAt(actor, PERMISSIONS.autoconfigRead, { tenantId });
      return [tenantId];
    }
    if (actor.isMspRoot && actor.hasGlobalGrant) return null;
    return actor.accessibleTenantIds.filter((id) =>
      isAllowed(actor.grants, PERMISSIONS.autoconfigRead, { tenantId: id }),
    );
  }

  async list(actor: Actor, tenantId?: string): Promise<PackageSummary[]> {
    const tenants = this.readable(actor, tenantId);
    const rows = await this.prisma.client.autoconfigPackage.findMany({
      where: tenants ? { tenantId: { in: tenants } } : {},
      include: { tenant: { select: { name: true } } },
      orderBy: [{ tenantId: 'asc' }, { filename: 'asc' }],
    });
    const usedBy = await this.usedBy([...new Set(rows.map((row) => row.tenantId))]);
    return rows.map((row) => this.describe(row, usedBy.get(row.id) ?? []));
  }

  async get(id: string, actor: Actor): Promise<PackageSummary> {
    const row = await this.row(id);
    assertAllowedAt(actor, PERMISSIONS.autoconfigRead, { tenantId: row.tenantId });
    return this.describe(row, (await this.usedBy([row.tenantId])).get(row.id) ?? []);
  }

  private async row(id: string): Promise<PackageRow> {
    const row = await this.prisma.client.autoconfigPackage.findUnique({
      where: { id },
      include: { tenant: { select: { name: true } } },
    });
    if (!row) throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });
    return row;
  }

  private describe(row: PackageRow, usedBy: { id: string; name: string }[]): PackageSummary {
    return {
      id: row.id,
      tenantId: row.tenantId,
      tenantName: row.tenant.name,
      filename: row.filename,
      kind: row.kind,
      state: row.state,
      sizeBytes: Number(row.sizeBytes),
      receivedBytes: Number(row.receivedBytes),
      sha256: row.sha256,
      jobId: row.jobId,
      createdBy: row.createdByLabel,
      createdAt: row.createdAt.toISOString(),
      readyAt: row.readyAt?.toISOString() ?? null,
      errorCode: row.errorCode,
      usedBy,
    };
  }

  /** Which of these tenants' own Windows templates run which package. */
  private async usedBy(tenantIds: string[]): Promise<Map<string, { id: string; name: string }[]>> {
    const out = new Map<string, { id: string; name: string }[]>();
    if (tenantIds.length === 0) return out;
    const templates = await this.prisma.client.autoconfigTemplate.findMany({
      where: { tenantId: { in: tenantIds }, family: 'WINDOWS' },
      select: { id: true, name: true, settings: true },
    });
    for (const template of templates) {
      const packages = (template.settings as { packages?: { packageId: string }[] }).packages ?? [];
      for (const { packageId } of packages) {
        const list = out.get(packageId) ?? [];
        if (!list.some((t) => t.id === template.id))
          list.push({ id: template.id, name: template.name });
        out.set(packageId, list);
      }
    }
    return out;
  }

  /**
   * A template's packages, checked against the tenant that owns it: each one
   * that tenant's, and ready. Called when a template is saved and when a VM is
   * requested — a package removed or failed in between is refused at the form,
   * not discovered by a guest.
   *
   * Looked up outside the caller's scope, by the owner's tenant: a customer
   * building from an MSP template may not read the MSP's packages, and must
   * still be told when one is missing. Only an id comes back, never a name.
   */
  async assertTemplatePackages(ownerTenantId: string, settings: TemplateSettings): Promise<void> {
    if (settings.family !== 'WINDOWS' || settings.packages.length === 0) return;
    const ids = [...new Set(settings.packages.map((p) => p.packageId))];
    const found = await withSystemScope(
      'a template’s packages are checked against its owner, whom the caller may not read',
      async () =>
        await this.prisma.client.autoconfigPackage.findMany({
          where: { id: { in: ids }, tenantId: ownerTenantId, state: 'READY' },
          select: { id: true },
        }),
    );
    const ready = new Set(found.map((row) => row.id));
    const missing = ids.find((id) => !ready.has(id));
    if (missing) {
      throw new VelnoxError(ERROR_CODES.autoconfigPackageUnavailable, {
        status: 400,
        params: { packageId: missing },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Uploading
  // -------------------------------------------------------------------------

  async startUpload(
    input: { tenantId: string; filename: string; sizeBytes: number },
    actor: Actor,
  ): Promise<{ item: PackageSummary; chunkBytes: number }> {
    assertAllowedAt(actor, PERMISSIONS.autoconfigManage, { tenantId: input.tenantId });
    const tenant = await this.prisma.client.tenant.findUnique({
      where: { id: input.tenantId },
      select: { status: true, deletedAt: true },
    });
    if (!tenant || tenant.status !== 'ACTIVE' || tenant.deletedAt) {
      throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });
    }
    const filename = input.filename.trim();
    const kind = packageKindForFilename(filename);
    if (!kind || !isValidPackageFilename(filename)) {
      throw new VelnoxError(ERROR_CODES.autoconfigPackageInvalidName, {
        status: 400,
        params: { filename },
      });
    }
    if (input.sizeBytes > PACKAGE_MAX_BYTES) {
      throw new VelnoxError(ERROR_CODES.autoconfigPackageTooLarge, {
        status: 400,
        params: { maxBytes: PACKAGE_MAX_BYTES },
      });
    }
    const refusal = checkCapacity(
      await readLibraryCapacity(this.prisma.client, this.limits),
      input.sizeBytes,
    );
    if (refusal) throw new VelnoxError(refusal.code, { status: 409, params: refusal.params });
    await this.ensureDirs();

    let row: PackageRow;
    try {
      row = await this.prisma.client.autoconfigPackage.create({
        data: {
          tenantId: input.tenantId,
          filename,
          kind,
          sizeBytes: BigInt(input.sizeBytes),
          createdById: actor.id,
          createdByLabel: actor.email,
        },
        include: { tenant: { select: { name: true } } },
      });
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'P2002') {
        throw new VelnoxError(ERROR_CODES.autoconfigPackageNameTaken, {
          status: 409,
          params: { filename },
        });
      }
      throw error;
    }
    // Created empty now, so every chunk is a write into a file that exists.
    const handle = await open(this.paths.packagePartial(row.id), 'w');
    await handle.close();

    await this.audited(AUDIT_ACTIONS.autoconfigPackageAdded, row, actor, {
      kind,
      sizeBytes: input.sizeBytes,
    });
    return { item: this.describe(row, []), chunkBytes: UPLOAD_CHUNK_PREFERRED };
  }

  private async managedRow(id: string, actor: Actor): Promise<PackageRow> {
    const row = await this.row(id);
    assertAllowedAt(actor, PERMISSIONS.autoconfigManage, { tenantId: row.tenantId });
    return row;
  }

  async uploadStatus(id: string, actor: Actor): Promise<PackageSummary> {
    return this.describe(await this.managedRow(id, actor), []);
  }

  /** One chunk at `offset`; the library's rules exactly (LibraryService.writeChunk). */
  async writeChunk(
    id: string,
    offset: number,
    declaredLength: number,
    body: Readable,
    actor: Actor,
  ): Promise<{ item: PackageSummary; job: JobDetail | null }> {
    const row = await this.managedRow(id, actor);
    const size = Number(row.sizeBytes);
    const received = Number(row.receivedBytes);

    if (row.state !== 'RECEIVING') {
      throw new VelnoxError(ERROR_CODES.libraryNotReady, {
        status: 409,
        params: { state: row.state },
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
      createWriteStream(this.paths.packagePartial(id), { flags: 'r+', start: offset }),
    );
    if (written !== declaredLength) {
      throw new VelnoxError(ERROR_CODES.librarySizeMismatch, {
        status: 400,
        params: { expected: declaredLength, got: written },
      });
    }

    const next = offset + written;
    const advanced = await this.prisma.client.autoconfigPackage.updateMany({
      where: { id, state: 'RECEIVING', receivedBytes: BigInt(offset) },
      data: { receivedBytes: BigInt(next), ...(next === size ? { state: 'VERIFYING' } : {}) },
    });

    let job: JobDetail | null = null;
    if (advanced.count === 1 && next === size) {
      try {
        job = await this.jobs.create(
          {
            tenantId: row.tenantId,
            type: JOB_TYPES.packageVerify,
            params: { packageId: id },
            concurrencyKey: `package:${id}`,
            concurrencyLabel: row.filename,
            targetKind: 'autoconfig_package',
            targetIds: [id],
            parentJobId: null,
          },
          actor,
        );
      } catch (error) {
        // Without a job nothing will ever check it: it goes, rather than
        // waiting in VERIFYING for ever.
        await rm(this.paths.packagePartial(id), { force: true });
        await this.prisma.client.autoconfigPackage.delete({ where: { id } }).catch(() => undefined);
        throw error;
      }
      await this.prisma.client.autoconfigPackage.update({
        where: { id },
        data: { jobId: job.id },
      });
    }
    return { item: this.describe(await this.row(id), []), job };
  }

  // -------------------------------------------------------------------------
  // Removing
  // -------------------------------------------------------------------------

  /**
   * Remove a package, or abandon its upload. Refused while it is being checked,
   * and while a template of its tenant still runs it.
   */
  async remove(id: string, actor: Actor): Promise<void> {
    const row = await this.managedRow(id, actor);
    if (row.state === 'VERIFYING') {
      throw new VelnoxError(ERROR_CODES.libraryNotReady, {
        status: 409,
        params: { state: row.state },
      });
    }
    const usedBy = (await this.usedBy([row.tenantId])).get(row.id) ?? [];
    if (usedBy.length > 0) {
      throw new VelnoxError(ERROR_CODES.autoconfigPackageInUse, {
        status: 409,
        params: { templates: usedBy.map((t) => t.name).join(', ') },
      });
    }
    await this.prisma.client.autoconfigPackage.delete({ where: { id: row.id } });
    await rm(this.paths.packagePartial(row.id), { force: true });
    await rm(this.paths.package(row.id), { force: true });
    await this.audited(AUDIT_ACTIONS.autoconfigPackageRemoved, row, actor, {
      state: row.state,
    });
  }

  private async audited(
    action: string,
    row: { id: string; filename: string; tenantId: string },
    actor: Actor,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.success(action, {
      actorType: 'USER',
      actorId: actor.id,
      actorLabel: actor.email,
      tenantId: row.tenantId,
      resourceType: 'autoconfig_package',
      resourceId: row.id,
      resourceLabel: row.filename,
      metadata,
    });
  }
}

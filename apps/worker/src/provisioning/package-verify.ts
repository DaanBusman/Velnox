import { open, rename, rm } from 'node:fs/promises';
import { ERROR_CODES, packageMagicMatches } from '@velnox/shared';
import { StepError, type Playbook } from '../jobs/steps';
import { hashFile } from '../library/playbooks';
import type { LibraryServices } from '../library/services';

/**
 * autoconfig.package_verify — an uploaded installer package, checked and made
 * available (Phase 5C).
 *
 * The same shape as the library's check: every byte counted and hashed, the
 * first ones read to see the file is what its name says — an MSI is an OLE
 * compound file, an EXE starts with `MZ` — and only then moved into place.
 * Cancelled, the upload is as if it never happened; failed, the package is
 * kept as FAILED with its reason, without its bytes.
 */

function parseParams(raw: unknown): { packageId: string } {
  const value = raw as { packageId?: unknown } | null;
  if (!value || typeof value.packageId !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.packageId)) {
    throw new StepError(ERROR_CODES.validation, 'autoconfig.package_verify needs a packageId');
  }
  return { packageId: value.packageId };
}

export function packageVerifyPlaybook(
  raw: unknown,
  jobId: string,
  services: LibraryServices,
): Playbook {
  const { packageId } = parseParams(raw);
  const { prisma, paths } = services;
  let lastError: unknown = null;
  let checked: { bytes: number; sha256: string } | null = null;

  const remember = <T>(run: () => Promise<T>) =>
    run().catch((error: unknown) => {
      lastError = error;
      throw error;
    });

  const load = async () => {
    const row = await prisma.autoconfigPackage.findUnique({ where: { id: packageId } });
    if (!row) throw new StepError(ERROR_CODES.notFound, `Package ${packageId} is gone`);
    return row;
  };

  return {
    version: 1,
    steps: [
      {
        kind: 'task',
        key: 'checksum',
        phase: 'verify',
        run: (context) =>
          remember(async () => {
            const row = await load();
            if (row.state !== 'VERIFYING') {
              throw new StepError(ERROR_CODES.libraryNotReady, `${row.filename} is not complete`);
            }
            await prisma.autoconfigPackage.update({ where: { id: packageId }, data: { jobId } });
            const size = Number(row.sizeBytes);
            checked = await hashFile(paths.packagePartial(packageId), context, size);
            if (checked.bytes !== size) {
              throw new StepError(
                ERROR_CODES.librarySizeMismatch,
                `${row.filename}: ${size} bytes were declared and ${checked.bytes} are on disk`,
                { filename: row.filename },
              );
            }
            await context.log(
              'STDOUT',
              `${row.filename}: ${checked.bytes} bytes, sha256 ${checked.sha256}`,
            );
            return { bytes: checked.bytes, sha256: checked.sha256 };
          }),
      },
      {
        kind: 'task',
        key: 'verify',
        phase: 'verify',
        run: (context) =>
          remember(async () => {
            const row = await load();
            const partial = paths.packagePartial(packageId);
            const handle = await open(partial, 'r');
            const head = Buffer.alloc(8);
            try {
              await handle.read(head, 0, head.length, 0);
            } finally {
              await handle.close();
            }
            if (!packageMagicMatches(row.kind, head)) {
              throw new StepError(
                ERROR_CODES.autoconfigPackageNotInstaller,
                `${row.filename} is named as an ${row.kind} but is not one`,
                { filename: row.filename, kind: row.kind },
              );
            }
            const result = checked ?? (await hashFile(partial, context, Number(row.sizeBytes)));
            await rename(partial, paths.package(packageId));
            await prisma.autoconfigPackage.update({
              where: { id: packageId },
              data: {
                state: 'READY',
                sha256: result.sha256,
                readyAt: new Date(),
                jobId: null,
                errorCode: null,
                errorDetail: null,
              },
            });
            await context.log('STDOUT', `${row.filename} is ready for its tenant's templates`);
            return { filename: row.filename, kind: row.kind, sha256: result.sha256 };
          }),
      },
    ],
    async cleanup(reason) {
      await rm(paths.packagePartial(packageId), { force: true });
      const row = await prisma.autoconfigPackage.findUnique({ where: { id: packageId } });
      if (!row || row.state === 'READY') return;
      if (reason === 'cancelled') {
        await prisma.autoconfigPackage.delete({ where: { id: packageId } });
        return;
      }
      const error = lastError;
      await prisma.autoconfigPackage.update({
        where: { id: packageId },
        data: {
          state: 'FAILED',
          jobId: null,
          errorCode: error instanceof StepError ? error.code : ERROR_CODES.generic,
          errorDetail:
            error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
        },
      });
    },
  };
}

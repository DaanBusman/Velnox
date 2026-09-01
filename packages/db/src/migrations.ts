import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';

/**
 * Migration state, for the readiness probe.
 *
 * `/readyz` must fail when the running code expects a schema the database does
 * not have. Comparing the migrations shipped in the image against the ones
 * recorded in `_prisma_migrations` answers that directly, rather than inferring
 * it from a query failing somewhere later.
 */

export interface MigrationState {
  applied: string[];
  expected: string[];
  /** Shipped in this build but not applied to the database. The dangerous direction. */
  pending: string[];
  /** Applied to the database but not shipped in this build — the database is ahead. */
  unknown: string[];
  /** Recorded as started but never finished, or rolled back. */
  failed: string[];
}

/** Directory containing the migration folders, resolved relative to this package. */
export function migrationsDir(): string {
  return join(__dirname, '..', 'prisma', 'migrations');
}

export function expectedMigrations(dir: string = migrationsDir()): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

interface MigrationRow {
  migration_name: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
}

export async function readMigrationState(prisma: PrismaClient): Promise<MigrationState> {
  const expected = expectedMigrations();

  // `_prisma_migrations` is Prisma's own bookkeeping table. It has no model, no
  // tenant column, and is not reachable through the typed client. Reading it is
  // the only way to know whether the schema matches the code.
  // eslint-disable-next-line no-restricted-syntax
  const rows = await prisma.$queryRaw<MigrationRow[]>`
    SELECT migration_name, finished_at, rolled_back_at
    FROM _prisma_migrations
    ORDER BY migration_name ASC
  `;

  const applied = rows
    .filter((r) => r.finished_at !== null && r.rolled_back_at === null)
    .map((r) => r.migration_name);
  const failed = rows
    .filter((r) => r.finished_at === null || r.rolled_back_at !== null)
    .map((r) => r.migration_name);

  const appliedSet = new Set(applied);
  const expectedSet = new Set(expected);

  return {
    applied,
    expected,
    pending: expected.filter((m) => !appliedSet.has(m)),
    unknown: applied.filter((m) => !expectedSet.has(m)),
    failed,
  };
}

/**
 * A build is ready when nothing it expects is missing and nothing failed.
 *
 * A database that is *ahead* of the build is reported as degraded rather than
 * down: during a rolling deployment an old replica briefly sees new migrations,
 * and refusing traffic there would turn a normal deployment into an outage.
 */
export function migrationStatus(state: MigrationState): 'ok' | 'degraded' | 'down' {
  if (state.pending.length > 0 || state.failed.length > 0) return 'down';
  if (state.unknown.length > 0) return 'degraded';
  return 'ok';
}

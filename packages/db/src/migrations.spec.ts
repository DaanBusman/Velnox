import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { expectedMigrations, migrationStatus, type MigrationState } from './migrations';

const state = (overrides: Partial<MigrationState> = {}): MigrationState => ({
  applied: [],
  expected: [],
  pending: [],
  unknown: [],
  failed: [],
  ...overrides,
});

describe('expectedMigrations', () => {
  it('discovers the migrations shipped in this package', () => {
    const found = expectedMigrations(join(process.cwd(), 'prisma', 'migrations'));
    expect(found).toContain('20260831120000_init_system_settings');
  });

  it('ignores migration_lock.toml, which is a file rather than a migration', () => {
    const found = expectedMigrations(join(process.cwd(), 'prisma', 'migrations'));
    expect(found).not.toContain('migration_lock.toml');
  });

  it('returns nothing for a directory that does not exist, rather than throwing', () => {
    expect(expectedMigrations(join(process.cwd(), 'does-not-exist'))).toEqual([]);
  });
});

describe('migrationStatus', () => {
  it('is ok when the database matches the build', () => {
    expect(migrationStatus(state({ applied: ['a'], expected: ['a'] }))).toBe('ok');
  });

  it('is down when the build expects a migration the database has not applied', () => {
    // The dangerous direction: this build will query columns that do not exist.
    expect(migrationStatus(state({ expected: ['a'], pending: ['a'] }))).toBe('down');
  });

  it('is down when a migration failed or was rolled back', () => {
    expect(migrationStatus(state({ applied: ['a'], expected: ['a'], failed: ['b'] }))).toBe('down');
  });

  it('is only degraded when the database is ahead of the build', () => {
    // A rolling deployment briefly leaves an old replica behind a newer schema.
    // Refusing traffic there would turn a normal deployment into an outage.
    expect(migrationStatus(state({ applied: ['a', 'b'], expected: ['a'], unknown: ['b'] }))).toBe(
      'degraded',
    );
  });

  it('treats pending as worse than unknown when both are present', () => {
    expect(migrationStatus(state({ pending: ['c'], unknown: ['b'] }))).toBe('down');
  });
});

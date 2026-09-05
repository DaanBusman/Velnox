import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The migration that makes an installation recoverable.
 *
 * An administrator could revoke their own last role. On an installation with one
 * account — which is every installation on its first day — that removed the last
 * permission in the system and locked every human out. Signing in still worked;
 * nothing was allowed; the only way back was a psql prompt.
 *
 * The application refuses it now, and `user-admin.service.ts` is where that
 * lives. This file covers the half that cannot be tested from the application:
 * the migration has to mark exactly one account on installations that already
 * exist, and repair one that has already been stranded. Getting that wrong is
 * discovered by an operator running an upgrade, which is the worst place to
 * discover it.
 */

const MIGRATION = readFileSync(
  join(__dirname, '..', 'prisma', 'migrations', '20260905140000_founding_administrator', 'migration.sql'),
  'utf8',
);

describe('founding administrator migration', () => {
  it('adds the column with a safe default', () => {
    // NOT NULL without a default would fail on any table that already has rows.
    expect(MIGRATION).toMatch(/ADD COLUMN "is_founding_administrator" BOOLEAN NOT NULL DEFAULT false/);
  });

  it('marks the oldest MSP root account, deterministically', () => {
    // Two accounts created in the same millisecond would otherwise make the
    // choice depend on the plan the database happened to pick.
    expect(MIGRATION).toMatch(/ORDER BY u2\."created_at" ASC, u2\."id" ASC/);
    expect(MIGRATION).toMatch(/LIMIT 1/);
    expect(MIGRATION).toMatch(/t\."kind" = 'MSP_ROOT'/);
  });

  it('ignores soft-deleted accounts when choosing', () => {
    expect(MIGRATION).toMatch(/u2\."deleted_at" IS NULL/);
  });

  it('allows only one founding administrator, enforced by the database', () => {
    expect(MIGRATION).toMatch(/CREATE UNIQUE INDEX "users_single_founding_administrator"/);
    // Partial, or the index would allow exactly one row with `false` as well.
    expect(MIGRATION).toMatch(/WHERE "is_founding_administrator"/);
  });

  it('restores a grant that was taken away, without duplicating one that was not', () => {
    expect(MIGRATION).toMatch(/INSERT INTO "role_assignments"/);
    expect(MIGRATION).toMatch(/r\."key" = 'msp_super_administrator'/);
    expect(MIGRATION).toMatch(/NOT EXISTS/);
  });

  it('grants the system role, not a tenant role that happens to share its key', () => {
    expect(MIGRATION).toMatch(/r\."tenant_id" IS NULL/);
  });

  it('invalidates tokens issued from the old grants', () => {
    // Without this the repaired account keeps a token built before the grant
    // came back, and appears to still have nothing.
    expect(MIGRATION).toMatch(/SET "token_version" = "token_version" \+ 1/);
  });

  it('explains why restoring a grant is not privilege escalation', () => {
    // This migration hands an account permissions it did not have a moment ago.
    // The reasoning has to survive next to the SQL, or a future reader will
    // reasonably be alarmed by it.
    expect(MIGRATION).toMatch(/Repair, not escalation/i);
  });
});

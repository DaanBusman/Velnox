-- The founding administrator: the way back into a misconfigured installation.
--
-- An administrator could revoke their own last role. On an installation with one
-- account — which is every installation on its first day — that removed the last
-- permission in the system and locked every human out of the product. Signing in
-- still worked; there was simply nothing anyone was allowed to do, and no way
-- back that did not involve opening a psql prompt.
--
-- The account the setup wizard creates is now marked, and its grants are
-- inalienable. Other administrators may still disable it, which is a reversible
-- act by anyone who still holds permissions; taking its permissions away is not.

ALTER TABLE "users"
  ADD COLUMN "is_founding_administrator" BOOLEAN NOT NULL DEFAULT false;

-- Mark the account setup created: the oldest one in the MSP root tenant.
--
-- Existing installations have no other record of which account that was. The
-- setup wizard creates exactly one user inside its transaction, so on any
-- installation that has not had users added before this migration the oldest is
-- the right one, and where users were added later the oldest is still the one
-- setup made.
UPDATE "users" u
SET "is_founding_administrator" = true
WHERE u."id" = (
  SELECT u2."id"
  FROM "users" u2
  JOIN "tenants" t ON t."id" = u2."tenant_id"
  WHERE t."kind" = 'MSP_ROOT' AND u2."deleted_at" IS NULL
  ORDER BY u2."created_at" ASC, u2."id" ASC
  LIMIT 1
);

-- At most one, enforced rather than assumed. A second founding administrator
-- would make "the account that cannot be locked out" ambiguous.
CREATE UNIQUE INDEX "users_single_founding_administrator"
  ON "users" ("is_founding_administrator")
  WHERE "is_founding_administrator";

-- Repair, not escalation.
--
-- An installation where the founding administrator has already lost their grant
-- is locked out right now. The rule this migration introduces is that those
-- grants cannot be taken away, so restoring one that was taken away is enforcing
-- the invariant rather than granting anything new. It touches nothing on an
-- installation where the grant is still present.
INSERT INTO "role_assignments" ("id", "user_id", "role_id", "scope_type", "scope_id", "granted_by", "granted_at")
SELECT
  gen_random_uuid(),
  u."id",
  r."id",
  'GLOBAL',
  NULL,
  u."id",
  now()
FROM "users" u
JOIN "tenants" t ON t."id" = u."tenant_id"
JOIN "roles" r ON r."key" = 'msp_super_administrator' AND r."tenant_id" IS NULL
WHERE u."is_founding_administrator"
  AND NOT EXISTS (
    SELECT 1
    FROM "role_assignments" ra
    WHERE ra."user_id" = u."id"
      AND ra."role_id" = r."id"
      AND ra."scope_type" = 'GLOBAL'
      AND ra."scope_id" IS NULL
  );

-- Any access token issued before this runs was built from the old grants.
UPDATE "users"
SET "token_version" = "token_version" + 1
WHERE "is_founding_administrator";

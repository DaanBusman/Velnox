-- Administrators can remove someone else's second factor.
--
-- Velnox had no override at all: an account that had lost both its authenticator
-- and its recovery codes was replaced rather than recovered. That is safe and
-- slow, and it leaves a disabled account behind for every mislaid phone.
--
-- Two permissions rather than one, because a colleague is not a customer:
--
--   users.reset_mfa      accounts in a customer tenant
--   users.reset_mfa_msp  additionally required for an account in the MSP root
--                        tenant — one that can reach every customer
--
-- The catalogue in packages/shared decides what a fresh installation seeds. This
-- migration is for the installations that already ran setup, whose roles were
-- written from the catalogue as it stood then.

-- MSP Super Administrator, MSP Administrator and MSP Engineer may put a customer
-- back into their account.
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT r."id", 'users.reset_mfa'
FROM "roles" r
WHERE r."is_system"
  AND r."tenant_id" IS NULL
  AND r."key" IN ('msp_super_administrator', 'msp_administrator', 'msp_engineer')
ON CONFLICT ("role_id", "permission") DO NOTHING;

-- Only the Super Administrator may do it to a colleague.
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT r."id", 'users.reset_mfa_msp'
FROM "roles" r
WHERE r."is_system"
  AND r."tenant_id" IS NULL
  AND r."key" = 'msp_super_administrator'
ON CONFLICT ("role_id", "permission") DO NOTHING;

-- No token_version bump.
--
-- Unlike a role assignment changing, this changes what a role contains, and
-- grants are resolved from the database on every request rather than carried in
-- the access token. Bumping would sign every administrator out for no gain.

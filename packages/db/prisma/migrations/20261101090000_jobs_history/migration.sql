-- Older jobs out of sight (0.7.16). The MSP Super Administrator may set a number
-- of days after which a finished job is hidden from everyone without
-- jobs.history. Null, the default, hides nothing. Nothing is deleted: the rows
-- stay, for the support logs and for whoever holds jobs.history.
ALTER TABLE "system_settings" ADD COLUMN "jobs_visible_days" INTEGER;
ALTER TABLE "system_settings"
    ADD CONSTRAINT "system_settings_jobs_visible_days_range"
    CHECK ("jobs_visible_days" IS NULL OR "jobs_visible_days" BETWEEN 1 AND 3650);

-- The new permission, for installations that already ran setup. The catalogue
-- in packages/shared decides what a fresh installation seeds; this matches it.
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT r."id", 'jobs.history'
FROM "roles" r
WHERE r."is_system"
  AND r."tenant_id" IS NULL
  AND r."key" IN ('msp_super_administrator', 'msp_administrator')
ON CONFLICT ("role_id", "permission") DO NOTHING;

-- The update check (0.7.21): on by default, switched off in Server management.
ALTER TABLE "system_settings"
  ADD COLUMN "update_check_enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "update_manifest" JSONB,
  ADD COLUMN "update_checked_at" TIMESTAMPTZ(3),
  ADD COLUMN "update_succeeded_at" TIMESTAMPTZ(3),
  ADD COLUMN "update_check_error" TEXT,
  ADD COLUMN "update_check_error_detail" TEXT;

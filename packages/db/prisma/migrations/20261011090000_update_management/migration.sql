-- Update management (Phase 6): what each node would update, whether it needs a
-- reboot, maintenance windows and update policies.

ALTER TABLE "nodes"
    ADD COLUMN "updates_security" INTEGER,
    ADD COLUMN "updates_kernel" INTEGER,
    ADD COLUMN "updates_proxmox" INTEGER,
    ADD COLUMN "updates_checked_at" TIMESTAMPTZ(3),
    ADD COLUMN "running_kernel" TEXT,
    ADD COLUMN "reboot_required" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "reboot_required_reason" TEXT;

CREATE TABLE "node_package_updates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "cluster_id" UUID NOT NULL,
    "node_id" UUID NOT NULL,
    "package" TEXT NOT NULL,
    "current_version" TEXT,
    "candidate_version" TEXT NOT NULL,
    "origin" TEXT,
    "is_security" BOOLEAN NOT NULL DEFAULT false,
    "is_kernel" BOOLEAN NOT NULL DEFAULT false,
    "is_proxmox" BOOLEAN NOT NULL DEFAULT false,
    "detected_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "node_package_updates_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "node_package_updates_node_id_package_key" ON "node_package_updates"("node_id", "package");
CREATE INDEX "node_package_updates_tenant_id_idx" ON "node_package_updates"("tenant_id");
ALTER TABLE "node_package_updates" ADD CONSTRAINT "node_package_updates_node_id_fkey"
    FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A package update, like its node, belongs to the node's tenant and cluster;
-- never trusted from the caller.
CREATE OR REPLACE FUNCTION velnox_package_update_owner()
RETURNS TRIGGER AS $$
BEGIN
    SELECT "tenant_id", "cluster_id" INTO NEW."tenant_id", NEW."cluster_id"
    FROM "nodes" WHERE "id" = NEW."node_id";
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "node_package_updates_owner_follows_node"
    BEFORE INSERT OR UPDATE ON "node_package_updates"
    FOR EACH ROW EXECUTE FUNCTION velnox_package_update_owner();

CREATE TYPE "reboot_policy" AS ENUM ('NEVER', 'IF_REQUIRED', 'ALWAYS');

CREATE TABLE "maintenance_windows" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "rrule" TEXT NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "blackout_dates" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "created_by_label" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "maintenance_windows_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "maintenance_windows_duration" CHECK ("duration_minutes" BETWEEN 15 AND 1440)
);
CREATE INDEX "maintenance_windows_tenant_id_idx" ON "maintenance_windows"("tenant_id");
CREATE UNIQUE INDEX "maintenance_windows_tenant_name" ON "maintenance_windows"("tenant_id", lower("name"));
ALTER TABLE "maintenance_windows" ADD CONSTRAINT "maintenance_windows_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "update_policies" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "cluster_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "auto_apply" BOOLEAN NOT NULL DEFAULT false,
    "require_approval" BOOLEAN NOT NULL DEFAULT false,
    "reboot_policy" "reboot_policy" NOT NULL DEFAULT 'IF_REQUIRED',
    "maintenance_window_id" UUID,
    "created_by_label" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "update_policies_pkey" PRIMARY KEY ("id"),
    -- Updating by itself without a window would update at any hour.
    CONSTRAINT "update_policies_auto_needs_window" CHECK (NOT "auto_apply" OR "maintenance_window_id" IS NOT NULL)
);
CREATE UNIQUE INDEX "update_policies_cluster_id_key" ON "update_policies"("cluster_id");
CREATE INDEX "update_policies_tenant_id_idx" ON "update_policies"("tenant_id");
ALTER TABLE "update_policies" ADD CONSTRAINT "update_policies_cluster_id_fkey"
    FOREIGN KEY ("cluster_id") REFERENCES "clusters"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "update_policies" ADD CONSTRAINT "update_policies_maintenance_window_id_fkey"
    FOREIGN KEY ("maintenance_window_id") REFERENCES "maintenance_windows"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A policy belongs to its cluster's tenant, and its window to the same tenant.
CREATE OR REPLACE FUNCTION velnox_update_policy_owner()
RETURNS TRIGGER AS $$
DECLARE
    window_tenant UUID;
BEGIN
    SELECT "tenant_id" INTO NEW."tenant_id" FROM "clusters" WHERE "id" = NEW."cluster_id";
    IF NEW."maintenance_window_id" IS NOT NULL THEN
        SELECT "tenant_id" INTO window_tenant FROM "maintenance_windows" WHERE "id" = NEW."maintenance_window_id";
        IF window_tenant IS DISTINCT FROM NEW."tenant_id" THEN
            RAISE EXCEPTION 'A policy''s maintenance window belongs to the cluster''s tenant';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "update_policies_owner_follows_cluster"
    BEFORE INSERT OR UPDATE ON "update_policies"
    FOR EACH ROW EXECUTE FUNCTION velnox_update_policy_owner();

-- The new permission, for installations that already ran setup.
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT r."id", 'updates.manage'
FROM "roles" r
WHERE r."is_system"
  AND r."tenant_id" IS NULL
  AND r."key" IN ('msp_super_administrator', 'msp_administrator', 'msp_engineer', 'tenant_administrator')
ON CONFLICT ("role_id", "permission") DO NOTHING;

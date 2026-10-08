-- Support logs (Phase 5C): the Proxmox task history of each node, and how long
-- it is kept.

CREATE TYPE "proxmox_task_origin" AS ENUM ('VELNOX', 'OUTSIDE_VELNOX');

CREATE TABLE "proxmox_tasks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "cluster_id" UUID NOT NULL,
    "node" TEXT NOT NULL,
    "upid" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "object_id" TEXT,
    "user" TEXT NOT NULL,
    "origin" "proxmox_task_origin" NOT NULL,
    "status" TEXT,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "ended_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "proxmox_tasks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "proxmox_tasks_cluster_id_upid_key" ON "proxmox_tasks"("cluster_id", "upid");
CREATE INDEX "proxmox_tasks_tenant_id_started_at_idx" ON "proxmox_tasks"("tenant_id", "started_at");
CREATE INDEX "proxmox_tasks_cluster_id_node_started_at_idx" ON "proxmox_tasks"("cluster_id", "node", "started_at");

ALTER TABLE "proxmox_tasks" ADD CONSTRAINT "proxmox_tasks_cluster_id_fkey"
    FOREIGN KEY ("cluster_id") REFERENCES "clusters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A task belongs to its cluster's tenant; never trusted from the caller.
CREATE OR REPLACE FUNCTION velnox_proxmox_task_tenant()
RETURNS TRIGGER AS $$
BEGIN
    SELECT "tenant_id" INTO NEW."tenant_id" FROM "clusters" WHERE "id" = NEW."cluster_id";
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "proxmox_tasks_tenant_follows_cluster"
    BEFORE INSERT OR UPDATE ON "proxmox_tasks"
    FOR EACH ROW EXECUTE FUNCTION velnox_proxmox_task_tenant();

-- At most thirty days, the owner's limit; shorter only by support.manage.
ALTER TABLE "system_settings"
    ADD COLUMN "support_log_retention_days" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "system_settings"
    ADD CONSTRAINT "system_settings_support_retention_range"
    CHECK ("support_log_retention_days" BETWEEN 1 AND 30);

-- The new permissions, for installations that already ran setup. The catalogue
-- in packages/shared decides what a fresh installation seeds; this matches it.
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT r."id", 'support.read'
FROM "roles" r
WHERE r."is_system"
  AND r."tenant_id" IS NULL
  AND r."key" IN ('msp_super_administrator', 'msp_administrator', 'msp_engineer', 'msp_read_only', 'tenant_administrator')
ON CONFLICT ("role_id", "permission") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission")
SELECT r."id", 'support.manage'
FROM "roles" r
WHERE r."is_system" AND r."tenant_id" IS NULL AND r."key" = 'msp_super_administrator'
ON CONFLICT ("role_id", "permission") DO NOTHING;

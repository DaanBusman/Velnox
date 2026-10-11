-- Placement (Phase 7B): which guests are kept apart or together, which nodes a
-- guest belongs on, and how Velnox keeps a cluster that way.

CREATE TYPE "placement_kind" AS ENUM ('KEEP_APART', 'KEEP_TOGETHER', 'PREFER_NODES');

CREATE TABLE "placement_rules" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "cluster_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "placement_kind" NOT NULL,
    "vmids" INTEGER[] NOT NULL,
    "nodes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "strict" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "ha_rule_id" TEXT,
    "ha_synced_at" TIMESTAMPTZ(3),
    "ha_sync_error" TEXT,
    "deleted_at" TIMESTAMPTZ(3),
    "created_by_label" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "placement_rules_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "placement_rules_members" CHECK (
        cardinality("vmids") BETWEEN 1 AND 50
        AND ("kind" = 'PREFER_NODES' OR cardinality("vmids") >= 2)
    ),
    CONSTRAINT "placement_rules_nodes" CHECK (
        ("kind" = 'PREFER_NODES') = (cardinality("nodes") >= 1)
    )
);
CREATE INDEX "placement_rules_tenant_id_idx" ON "placement_rules"("tenant_id");
CREATE INDEX "placement_rules_cluster_id_idx" ON "placement_rules"("cluster_id");
-- A name is unique among a cluster's rules that still exist.
CREATE UNIQUE INDEX "placement_rules_cluster_name" ON "placement_rules"("cluster_id", lower("name"))
    WHERE "deleted_at" IS NULL;
ALTER TABLE "placement_rules" ADD CONSTRAINT "placement_rules_cluster_id_fkey"
    FOREIGN KEY ("cluster_id") REFERENCES "clusters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "placement_settings" (
    "cluster_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "auto_correct" BOOLEAN NOT NULL DEFAULT false,
    "balance" BOOLEAN NOT NULL DEFAULT false,
    "balance_threshold_percent" INTEGER NOT NULL DEFAULT 20,
    "quiet_minutes" INTEGER NOT NULL DEFAULT 30,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "placement_settings_pkey" PRIMARY KEY ("cluster_id"),
    CONSTRAINT "placement_settings_threshold" CHECK ("balance_threshold_percent" BETWEEN 5 AND 80),
    CONSTRAINT "placement_settings_quiet" CHECK ("quiet_minutes" BETWEEN 5 AND 1440)
);
CREATE INDEX "placement_settings_tenant_id_idx" ON "placement_settings"("tenant_id");
ALTER TABLE "placement_settings" ADD CONSTRAINT "placement_settings_cluster_id_fkey"
    FOREIGN KEY ("cluster_id") REFERENCES "clusters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Both belong to their cluster's tenant; never trusted from the caller.
CREATE OR REPLACE FUNCTION velnox_placement_owner()
RETURNS TRIGGER AS $$
BEGIN
    SELECT "tenant_id" INTO NEW."tenant_id" FROM "clusters" WHERE "id" = NEW."cluster_id";
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "placement_rules_owner_follows_cluster"
    BEFORE INSERT OR UPDATE ON "placement_rules"
    FOR EACH ROW EXECUTE FUNCTION velnox_placement_owner();
CREATE TRIGGER "placement_settings_owner_follows_cluster"
    BEFORE INSERT OR UPDATE ON "placement_settings"
    FOR EACH ROW EXECUTE FUNCTION velnox_placement_owner();

-- The new permissions, for installations that already ran setup. Every role
-- reads; the roles that manage update policies also manage placement.
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT r."id", 'placement.read'
FROM "roles" r
WHERE r."is_system" AND r."tenant_id" IS NULL
ON CONFLICT ("role_id", "permission") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission")
SELECT r."id", 'placement.manage'
FROM "roles" r
WHERE r."is_system"
  AND r."tenant_id" IS NULL
  AND r."key" IN ('msp_super_administrator', 'msp_administrator', 'msp_engineer', 'tenant_administrator')
ON CONFLICT ("role_id", "permission") DO NOTHING;

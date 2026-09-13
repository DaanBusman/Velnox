-- Proxmox inventory.
--
-- Phase 4. Clusters, nodes, what runs on them, and Ceph.
--
-- A standalone node is a cluster of one. That is not a modelling flourish: every
-- later path — rolling updates, upgrade plans, quorum guards — would otherwise
-- have to branch on "is this standalone", in a dozen places, correctly, every
-- time.
--
-- Ceph daemons are rows rather than columns on a node because a Ceph upgrade
-- restarts daemons, not nodes. They are the unit of work for the phase 9A
-- playbook, the unit its guards evaluate, and the unit its report is written
-- against.
--
-- `tls_verify_mode` has no INSECURE value, and adding one would be a schema
-- change somebody has to argue for in a migration.

-- CreateEnum
CREATE TYPE "cluster_kind" AS ENUM ('CLUSTER', 'STANDALONE');

-- CreateEnum
CREATE TYPE "health_state" AS ENUM ('OK', 'WARNING', 'CRITICAL', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "tls_verify_mode" AS ENUM ('PINNED_FINGERPRINT', 'CA_BUNDLE', 'SYSTEM');

-- CreateEnum
CREATE TYPE "connection_state" AS ENUM ('PENDING', 'CONNECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "proxmox_auth_kind" AS ENUM ('API_TOKEN', 'TICKET');

-- CreateEnum
CREATE TYPE "node_state" AS ENUM ('ONLINE', 'OFFLINE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "workload_kind" AS ENUM ('QEMU', 'LXC');

-- CreateEnum
CREATE TYPE "workload_state" AS ENUM ('RUNNING', 'STOPPED', 'PAUSED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ceph_daemon_kind" AS ENUM ('MON', 'MGR', 'OSD', 'MDS', 'RGW');

-- CreateEnum
CREATE TYPE "discovery_state" AS ENUM ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED');

-- CreateTable
CREATE TABLE "clusters" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "site_id" UUID,
    "name" TEXT NOT NULL,
    "kind" "cluster_kind" NOT NULL DEFAULT 'CLUSTER',
    "endpoint_host" TEXT NOT NULL,
    "endpoint_port" INTEGER NOT NULL DEFAULT 8006,
    "tls_verify_mode" "tls_verify_mode" NOT NULL DEFAULT 'PINNED_FINGERPRINT',
    "tls_fingerprint" TEXT,
    "auth_kind" "proxmox_auth_kind" NOT NULL DEFAULT 'API_TOKEN',
    "credential_id" UUID,
    "auth_principal" TEXT,
    "connection_state" "connection_state" NOT NULL DEFAULT 'PENDING',
    "health" "health_state" NOT NULL DEFAULT 'UNKNOWN',
    "pve_version" TEXT,
    "pve_versions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "quorate" BOOLEAN,
    "node_count" INTEGER NOT NULL DEFAULT 0,
    "ceph_present" BOOLEAN NOT NULL DEFAULT false,
    "ceph_health" TEXT,
    "ceph_health_detail" JSONB NOT NULL DEFAULT '[]',
    "ceph_versions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ceph_versions_homogeneous" BOOLEAN,
    "ceph_osds_total" INTEGER,
    "ceph_osds_up" INTEGER,
    "ceph_osds_in" INTEGER,
    "ceph_pgs_total" INTEGER,
    "ceph_pgs_clean" BOOLEAN,
    "ceph_mon_quorum" INTEGER,
    "ceph_mon_total" INTEGER,
    "ceph_flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "last_seen_at" TIMESTAMPTZ(3),
    "last_discovery_at" TIMESTAMPTZ(3),
    "last_error_code" TEXT,
    "last_error_detail" TEXT,
    "discovery_interval_minutes" INTEGER NOT NULL DEFAULT 30,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "clusters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nodes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "cluster_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "node_id" INTEGER,
    "address" TEXT,
    "state" "node_state" NOT NULL DEFAULT 'UNKNOWN',
    "health" "health_state" NOT NULL DEFAULT 'UNKNOWN',
    "pve_version" TEXT,
    "kernel_version" TEXT,
    "subscription_status" TEXT,
    "subscription_level" TEXT,
    "cpu_count" INTEGER,
    "cpu_model" TEXT,
    "cpu_usage" DOUBLE PRECISION,
    "memory_total_bytes" BIGINT,
    "memory_used_bytes" BIGINT,
    "rootfs_total_bytes" BIGINT,
    "rootfs_used_bytes" BIGINT,
    "uptime_seconds" INTEGER,
    "updates_available" INTEGER,
    "repositories" JSONB NOT NULL DEFAULT '[]',
    "problems" JSONB NOT NULL DEFAULT '[]',
    "last_seen_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "node_storages" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "node_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "content" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "total_bytes" BIGINT,
    "used_bytes" BIGINT,
    "available_bytes" BIGINT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "node_storages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "node_interfaces" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "node_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "autostart" BOOLEAN NOT NULL DEFAULT false,
    "method" TEXT,
    "cidr" TEXT,
    "gateway" TEXT,
    "bridge_ports" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "bond_mode" TEXT,
    "slaves" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "comment" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "node_interfaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workloads" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "cluster_id" UUID NOT NULL,
    "node_id" UUID,
    "vmid" INTEGER NOT NULL,
    "kind" "workload_kind" NOT NULL,
    "name" TEXT,
    "state" "workload_state" NOT NULL DEFAULT 'UNKNOWN',
    "raw_status" TEXT,
    "template" BOOLEAN NOT NULL DEFAULT false,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pool" TEXT,
    "cpu_count" INTEGER,
    "cpu_usage" DOUBLE PRECISION,
    "memory_bytes" BIGINT,
    "memory_max_bytes" BIGINT,
    "disk_bytes" BIGINT,
    "disk_max_bytes" BIGINT,
    "uptime_seconds" INTEGER,
    "last_seen_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "workloads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ceph_daemons" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "cluster_id" UUID NOT NULL,
    "node_id" UUID,
    "kind" "ceph_daemon_kind" NOT NULL,
    "daemon_id" TEXT NOT NULL,
    "host" TEXT,
    "version" TEXT,
    "last_seen_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ceph_daemons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discovery_runs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "cluster_id" UUID NOT NULL,
    "state" "discovery_state" NOT NULL DEFAULT 'RUNNING',
    "requested_by" UUID,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),
    "duration_ms" INTEGER,
    "nodes_seen" INTEGER,
    "workloads_seen" INTEGER,
    "problems" JSONB NOT NULL DEFAULT '[]',
    "error_code" TEXT,
    "error_detail" TEXT,

    CONSTRAINT "discovery_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "clusters_tenant_id_idx" ON "clusters"("tenant_id");

-- CreateIndex
CREATE INDEX "clusters_site_id_idx" ON "clusters"("site_id");

-- CreateIndex
CREATE INDEX "nodes_tenant_id_idx" ON "nodes"("tenant_id");

-- CreateIndex
CREATE INDEX "nodes_cluster_id_idx" ON "nodes"("cluster_id");

-- CreateIndex
CREATE UNIQUE INDEX "nodes_cluster_id_name_key" ON "nodes"("cluster_id", "name");

-- CreateIndex
CREATE INDEX "node_storages_tenant_id_idx" ON "node_storages"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "node_storages_node_id_name_key" ON "node_storages"("node_id", "name");

-- CreateIndex
CREATE INDEX "node_interfaces_tenant_id_idx" ON "node_interfaces"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "node_interfaces_node_id_name_key" ON "node_interfaces"("node_id", "name");

-- CreateIndex
CREATE INDEX "workloads_tenant_id_idx" ON "workloads"("tenant_id");

-- CreateIndex
CREATE INDEX "workloads_cluster_id_idx" ON "workloads"("cluster_id");

-- CreateIndex
CREATE INDEX "workloads_node_id_idx" ON "workloads"("node_id");

-- CreateIndex
CREATE UNIQUE INDEX "workloads_cluster_id_vmid_key" ON "workloads"("cluster_id", "vmid");

-- CreateIndex
CREATE INDEX "ceph_daemons_tenant_id_idx" ON "ceph_daemons"("tenant_id");

-- CreateIndex
CREATE INDEX "ceph_daemons_cluster_id_idx" ON "ceph_daemons"("cluster_id");

-- CreateIndex
CREATE UNIQUE INDEX "ceph_daemons_cluster_id_daemon_id_key" ON "ceph_daemons"("cluster_id", "daemon_id");

-- CreateIndex
CREATE INDEX "discovery_runs_tenant_id_idx" ON "discovery_runs"("tenant_id");

-- CreateIndex
CREATE INDEX "discovery_runs_cluster_id_started_at_idx" ON "discovery_runs"("cluster_id", "started_at");

-- AddForeignKey
ALTER TABLE "clusters" ADD CONSTRAINT "clusters_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clusters" ADD CONSTRAINT "clusters_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_cluster_id_fkey" FOREIGN KEY ("cluster_id") REFERENCES "clusters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_storages" ADD CONSTRAINT "node_storages_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_interfaces" ADD CONSTRAINT "node_interfaces_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workloads" ADD CONSTRAINT "workloads_cluster_id_fkey" FOREIGN KEY ("cluster_id") REFERENCES "clusters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workloads" ADD CONSTRAINT "workloads_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ceph_daemons" ADD CONSTRAINT "ceph_daemons_cluster_id_fkey" FOREIGN KEY ("cluster_id") REFERENCES "clusters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ceph_daemons" ADD CONSTRAINT "ceph_daemons_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discovery_runs" ADD CONSTRAINT "discovery_runs_cluster_id_fkey" FOREIGN KEY ("cluster_id") REFERENCES "clusters"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A grant at CLUSTER scope must name a cluster that exists.
--
-- Replaces the function created with the sites migration, which validated TENANT
-- and SITE and left CLUSTER alone because clusters did not exist yet. It said so
-- at the time; this is that note being paid off rather than becoming permanent.
CREATE OR REPLACE FUNCTION velnox_assert_scope_target_exists()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."scope_type" = 'TENANT' THEN
        IF NOT EXISTS (SELECT 1 FROM "tenants" WHERE "id" = NEW."scope_id") THEN
            RAISE EXCEPTION 'Role assignment at TENANT scope names a tenant that does not exist: %',
                NEW."scope_id";
        END IF;
    ELSIF NEW."scope_type" = 'SITE' THEN
        IF NOT EXISTS (SELECT 1 FROM "sites" WHERE "id" = NEW."scope_id") THEN
            RAISE EXCEPTION 'Role assignment at SITE scope names a site that does not exist: %',
                NEW."scope_id";
        END IF;
    ELSIF NEW."scope_type" = 'CLUSTER' THEN
        IF NOT EXISTS (SELECT 1 FROM "clusters" WHERE "id" = NEW."scope_id") THEN
            RAISE EXCEPTION 'Role assignment at CLUSTER scope names a cluster that does not exist: %',
                NEW."scope_id";
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- And the denormalised tenant follows a cluster scope too.
CREATE OR REPLACE FUNCTION velnox_role_assignment_tenant()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."scope_type" = 'GLOBAL' THEN
        NEW."tenant_id" := NULL;
    ELSIF NEW."scope_type" = 'TENANT' THEN
        NEW."tenant_id" := NEW."scope_id";
    ELSIF NEW."scope_type" = 'SITE' THEN
        SELECT "tenant_id" INTO NEW."tenant_id" FROM "sites" WHERE "id" = NEW."scope_id";
    ELSIF NEW."scope_type" = 'CLUSTER' THEN
        SELECT "tenant_id" INTO NEW."tenant_id" FROM "clusters" WHERE "id" = NEW."scope_id";
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- A cluster's site has to belong to the cluster's tenant.
--
-- Two nullable foreign keys pointing at rows that each carry a tenant is exactly
-- the shape that ends up disagreeing. A cluster in tenant A hanging off a site
-- in tenant B would be invisible in both and would put an engineer scoped to
-- that site in front of another customer's infrastructure.
CREATE OR REPLACE FUNCTION velnox_assert_cluster_site_tenant()
RETURNS TRIGGER AS $$
DECLARE
    site_tenant UUID;
BEGIN
    IF NEW."site_id" IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT "tenant_id" INTO site_tenant FROM "sites" WHERE "id" = NEW."site_id";

    IF site_tenant IS DISTINCT FROM NEW."tenant_id" THEN
        RAISE EXCEPTION 'Cluster tenant % does not match the tenant of site %',
            NEW."tenant_id", NEW."site_id";
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "clusters_site_matches_tenant"
    BEFORE INSERT OR UPDATE ON "clusters"
    FOR EACH ROW EXECUTE FUNCTION velnox_assert_cluster_site_tenant();

-- The ISO library, the files on cluster storage it moves, and SSH for copying
-- files off a node.
--
-- Phase 5A. The library is installation-wide: one store on one disk, filled by
-- MSP staff and chosen from by everyone, so `library_items` has no tenant and no
-- relation to anything that has one. `storage_contents` describes somebody's
-- cluster, so it carries the cluster's tenant like every other inventory table.
--
-- SSH is optional per cluster and exists for one thing: Proxmox's API can put a
-- file on a node and delete one, but has no call to read one back. See ADR-038.

-- CreateEnum
CREATE TYPE "library_item_kind" AS ENUM ('ISO', 'DISK_IMAGE');

-- CreateEnum
CREATE TYPE "library_item_state" AS ENUM ('RECEIVING', 'VERIFYING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "library_item_source" AS ENUM ('UPLOAD', 'URL', 'CLUSTER');

-- AlterTable
ALTER TABLE "clusters" ADD COLUMN     "ssh_credential_id" UUID,
ADD COLUMN     "ssh_port" INTEGER NOT NULL DEFAULT 22,
ADD COLUMN     "ssh_username" TEXT,
ADD COLUMN     "ssh_verified_at" TIMESTAMPTZ(3);

-- AlterTable
-- The values a job's error message is written around. Phase 5A's refusals
-- ("the library holds 95 of 100 GB") are the first that need them.
ALTER TABLE "jobs" ADD COLUMN     "error_params" JSONB;

-- AlterTable
ALTER TABLE "nodes" ADD COLUMN     "ssh_host_key_fingerprint" TEXT,
ADD COLUMN     "ssh_host_key_type" TEXT;

-- CreateTable
CREATE TABLE "storage_contents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "cluster_id" UUID NOT NULL,
    "node_name" TEXT NOT NULL,
    "storage" TEXT NOT NULL,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "location_key" TEXT NOT NULL,
    "volid" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "format" TEXT,
    "size_bytes" BIGINT,
    "file_created_at" TIMESTAMPTZ(3),
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "storage_contents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "library_items" (
    "id" UUID NOT NULL,
    "kind" "library_item_kind" NOT NULL,
    "state" "library_item_state" NOT NULL DEFAULT 'RECEIVING',
    "source" "library_item_source" NOT NULL,
    "filename" TEXT NOT NULL,
    "size_bytes" BIGINT,
    "received_bytes" BIGINT NOT NULL DEFAULT 0,
    "sha256" TEXT,
    "disk_format" TEXT,
    "title_override" TEXT,
    "language_override" TEXT,
    "source_url" TEXT,
    "source_cluster_id" UUID,
    "source_cluster_name" TEXT,
    "source_volid" TEXT,
    "job_id" UUID,
    "created_by_id" UUID,
    "created_by_label" TEXT,
    "error_code" TEXT,
    "error_params" JSONB,
    "error_detail" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "ready_at" TIMESTAMPTZ(3),

    CONSTRAINT "library_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "storage_contents_tenant_id_idx" ON "storage_contents"("tenant_id");

-- CreateIndex
CREATE INDEX "storage_contents_cluster_id_idx" ON "storage_contents"("cluster_id");

-- CreateIndex
CREATE UNIQUE INDEX "storage_contents_cluster_id_location_key_volid_key" ON "storage_contents"("cluster_id", "location_key", "volid");

-- CreateIndex
CREATE INDEX "library_items_state_idx" ON "library_items"("state");

-- AddForeignKey
ALTER TABLE "storage_contents" ADD CONSTRAINT "storage_contents_cluster_id_fkey" FOREIGN KEY ("cluster_id") REFERENCES "clusters"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- One live item per filename.
--
-- Case-insensitive because the storages Proxmox runs on are not all
-- case-sensitive, and two library items differing only in case would land on a
-- CIFS share as one file. FAILED items are excluded so a failed fetch does not
-- block a second attempt under the same name.
CREATE UNIQUE INDEX "library_items_filename_live" ON "library_items" (lower("filename"))
    WHERE "state" <> 'FAILED';

ALTER TABLE "library_items"
    ADD CONSTRAINT "library_items_sizes_sane" CHECK (
        "received_bytes" >= 0
        AND ("size_bytes" IS NULL OR "size_bytes" >= 0)
        AND ("size_bytes" IS NULL OR "received_bytes" <= "size_bytes")
    ),
    ADD CONSTRAINT "library_items_sha256_hex" CHECK ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT "library_items_disk_format" CHECK (
        ("kind" = 'ISO' AND "disk_format" IS NULL)
        OR ("kind" = 'DISK_IMAGE' AND ("disk_format" IS NULL OR "disk_format" IN ('qcow2', 'raw')))
    ),
    -- READY means every byte is here and was checked. A READY row without a
    -- checksum or a size would be a claim nothing backs.
    ADD CONSTRAINT "library_items_ready_is_complete" CHECK (
        "state" <> 'READY'
        OR ("sha256" IS NOT NULL AND "size_bytes" IS NOT NULL AND "received_bytes" = "size_bytes")
    );

ALTER TABLE "storage_contents"
    ADD CONSTRAINT "storage_contents_content" CHECK ("content" IN ('iso', 'import'));

ALTER TABLE "clusters"
    ADD CONSTRAINT "clusters_ssh_port" CHECK ("ssh_port" BETWEEN 1 AND 65535),
    -- A key without a user, or a user without a key, is half a configuration
    -- that would fail every copy with a confusing error.
    ADD CONSTRAINT "clusters_ssh_complete" CHECK (
        ("ssh_credential_id" IS NULL) = ("ssh_username" IS NULL)
    );

-- A file on a cluster's storage belongs to the cluster's tenant.
--
-- The worker writes these, from discovery, with the cluster's tenant copied in.
-- The copy is what the tenancy filter reads, so a mismatch would show one
-- customer another's files. The trigger makes the copy impossible to get wrong.
CREATE OR REPLACE FUNCTION velnox_assert_storage_content_tenant()
RETURNS TRIGGER AS $$
DECLARE
    cluster_tenant UUID;
BEGIN
    SELECT "tenant_id" INTO cluster_tenant FROM "clusters" WHERE "id" = NEW."cluster_id";

    IF cluster_tenant IS DISTINCT FROM NEW."tenant_id" THEN
        RAISE EXCEPTION 'Storage content tenant % does not match the tenant of cluster %',
            NEW."tenant_id", NEW."cluster_id";
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "storage_contents_tenant_matches_cluster"
    BEFORE INSERT OR UPDATE ON "storage_contents"
    FOR EACH ROW EXECUTE FUNCTION velnox_assert_storage_content_tenant();

-- The two new permissions, for installations that already ran setup.
--
-- The catalogue in packages/shared decides what a fresh installation seeds; this
-- is for roles written from the catalogue as it stood before. `library.read` is
-- a read permission and every system role holds all of those except where the
-- catalogue says otherwise, which for this one it does not.
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT r."id", 'library.read'
FROM "roles" r
WHERE r."is_system" AND r."tenant_id" IS NULL
ON CONFLICT ("role_id", "permission") DO NOTHING;

-- Adding to and removing from the library: MSP roles that already operate the
-- fleet. Not tenant roles — the library is one disk for every customer.
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT r."id", 'library.manage'
FROM "roles" r
WHERE r."is_system"
  AND r."tenant_id" IS NULL
  AND r."key" IN ('msp_super_administrator', 'msp_administrator', 'msp_engineer')
ON CONFLICT ("role_id", "permission") DO NOTHING;

-- No token_version bump: grants are read from the database on every request.

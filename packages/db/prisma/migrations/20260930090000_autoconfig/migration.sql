-- Autoconfig templates, provisioning records, outgoing mail (Phase 5B).
--
-- A template is owned by the MSP root or by one customer tenant. Its settings
-- are plain JSON and its secrets are in the secret store; see ADR-039. A
-- provisioning is one VM built from a template, and belongs to the tenant of
-- the cluster it was built on, like everything else describing that cluster.
--
-- A template's secrets are one credential each (secret_refs), because the API
-- may write secrets and may not read them, and changing one password must not
-- need the others decrypted.
--
-- Four credential kinds arrive with it. Three are read only by the worker. One,
-- GUEST_CREDENTIALS, is also read by the API, for the audited reveal and for
-- nothing else.

-- CreateEnum
CREATE TYPE "smtp_security" AS ENUM ('STARTTLS', 'TLS', 'NONE');

-- CreateEnum
CREATE TYPE "template_os_family" AS ENUM ('WINDOWS', 'LINUX');

-- CreateEnum
CREATE TYPE "template_visibility" AS ENUM ('SHARED', 'PRIVATE');

-- CreateEnum
CREATE TYPE "credential_delivery" AS ENUM ('VELNOX_ONLY', 'ENCRYPTED_PDF');

-- CreateEnum
CREATE TYPE "pdf_password_source" AS ENUM ('SHOWN_ONCE', 'TEMPLATE');

-- CreateEnum
CREATE TYPE "provisioning_state" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- AlterEnum
-- Four credential kinds. PostgreSQL 12 and later allow several ADD VALUEs in one
-- transaction as long as nothing in it uses them, and nothing here does.

ALTER TYPE "credential_kind" ADD VALUE 'TEMPLATE_SECRETS';
ALTER TYPE "credential_kind" ADD VALUE 'GUEST_CREDENTIALS';
ALTER TYPE "credential_kind" ADD VALUE 'DOCUMENT_PASSWORD';
ALTER TYPE "credential_kind" ADD VALUE 'SMTP_PASSWORD';

-- AlterTable
ALTER TABLE "system_settings" ADD COLUMN     "smtp_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "smtp_from" TEXT,
ADD COLUMN     "smtp_host" TEXT,
ADD COLUMN     "smtp_password_credential_id" UUID,
ADD COLUMN     "smtp_port" INTEGER NOT NULL DEFAULT 587,
ADD COLUMN     "smtp_security" "smtp_security" NOT NULL DEFAULT 'STARTTLS',
ADD COLUMN     "smtp_username" TEXT,
ADD COLUMN     "smtp_verified_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "library_items" ADD COLUMN     "windows_images" JSONB;

-- CreateTable
CREATE TABLE "autoconfig_templates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "family" "template_os_family" NOT NULL,
    "visibility" "template_visibility" NOT NULL DEFAULT 'SHARED',
    "credential_delivery" "credential_delivery" NOT NULL DEFAULT 'VELNOX_ONLY',
    "pdf_password_source" "pdf_password_source" NOT NULL DEFAULT 'SHOWN_ONCE',
    "settings" JSONB NOT NULL,
    "secret_refs" JSONB NOT NULL DEFAULT '{}',
    "cloned_from_id" UUID,
    "cloned_from_name" TEXT,
    "created_by_id" UUID,
    "created_by_label" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "autoconfig_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provisionings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "template_id" UUID,
    "template_name" TEXT NOT NULL,
    "family" "template_os_family" NOT NULL,
    "template_snapshot" JSONB NOT NULL,
    "cluster_id" UUID,
    "cluster_name" TEXT NOT NULL,
    "node" TEXT NOT NULL,
    "disk_storage" TEXT NOT NULL,
    "media_storage" TEXT NOT NULL,
    "bridge" TEXT NOT NULL,
    "vlan" INTEGER,
    "hostname" TEXT NOT NULL,
    "network" JSONB NOT NULL,
    "vmid" INTEGER,
    "state" "provisioning_state" NOT NULL DEFAULT 'QUEUED',
    "job_id" UUID,
    "addresses" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requested_by_id" UUID,
    "requested_by_label" TEXT,
    "requested_by_email" TEXT,
    "credential_delivery" "credential_delivery" NOT NULL,
    "credentials_credential_id" UUID,
    "credentials_expire_at" TIMESTAMPTZ(3),
    "document_password_credential_id" UUID,
    "notify" BOOLEAN NOT NULL DEFAULT true,
    "notified_at" TIMESTAMPTZ(3),
    "error_code" TEXT,
    "error_params" JSONB,
    "error_detail" TEXT,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "provisionings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "autoconfig_templates_tenant_id_idx" ON "autoconfig_templates"("tenant_id");

-- CreateIndex
CREATE INDEX "provisionings_tenant_id_idx" ON "provisionings"("tenant_id");

-- CreateIndex
CREATE INDEX "provisionings_cluster_id_idx" ON "provisionings"("cluster_id");

-- CreateIndex
CREATE INDEX "provisionings_state_idx" ON "provisionings"("state");

-- AddForeignKey
ALTER TABLE "autoconfig_templates" ADD CONSTRAINT "autoconfig_templates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provisionings" ADD CONSTRAINT "provisionings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provisionings" ADD CONSTRAINT "provisionings_cluster_id_fkey" FOREIGN KEY ("cluster_id") REFERENCES "clusters"("id") ON DELETE SET NULL ON UPDATE CASCADE;



-- One template name per tenant, case-insensitively: two templates a person
-- cannot tell apart in a dropdown are one too many.
CREATE UNIQUE INDEX "autoconfig_templates_tenant_name" ON "autoconfig_templates" ("tenant_id", lower("name"));

ALTER TABLE "autoconfig_templates"
    ADD CONSTRAINT "autoconfig_templates_name_present" CHECK (length(btrim("name")) BETWEEN 1 AND 100),
    -- The family column and the settings must agree; the worker reads one and
    -- the list filters on the other.
    ADD CONSTRAINT "autoconfig_templates_family_matches" CHECK ("settings"->>'family' = "family"::text);

ALTER TABLE "provisionings"
    ADD CONSTRAINT "provisionings_vmid_range" CHECK ("vmid" IS NULL OR "vmid" BETWEEN 100 AND 999999999),
    ADD CONSTRAINT "provisionings_vlan_range" CHECK ("vlan" IS NULL OR "vlan" BETWEEN 1 AND 4094),
    ADD CONSTRAINT "provisionings_hostname" CHECK ("hostname" ~ '^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$'),
    ADD CONSTRAINT "provisionings_family_matches" CHECK ("template_snapshot"->>'family' = "family"::text);

ALTER TABLE "system_settings"
    ADD CONSTRAINT "system_settings_smtp_port" CHECK ("smtp_port" BETWEEN 1 AND 65535),
    -- Enabled means there is somewhere to send and someone to send as.
    ADD CONSTRAINT "system_settings_smtp_complete" CHECK (
        NOT "smtp_enabled" OR ("smtp_host" IS NOT NULL AND "smtp_from" IS NOT NULL)
    );

-- A provisioning belongs to the tenant of the cluster it builds on.
--
-- The API writes the cluster's tenant in; the tenancy filter reads it. A
-- mismatch would show one customer another's VM and its record, so the copy is
-- checked here rather than trusted. Once the cluster is removed the record
-- stays with the tenant it was written for.
CREATE OR REPLACE FUNCTION velnox_assert_provisioning_tenant()
RETURNS TRIGGER AS $$
DECLARE
    cluster_tenant UUID;
BEGIN
    IF NEW."cluster_id" IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT "tenant_id" INTO cluster_tenant FROM "clusters" WHERE "id" = NEW."cluster_id";

    IF cluster_tenant IS DISTINCT FROM NEW."tenant_id" THEN
        RAISE EXCEPTION 'Provisioning tenant % does not match the tenant of cluster %',
            NEW."tenant_id", NEW."cluster_id";
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "provisionings_tenant_matches_cluster"
    BEFORE INSERT OR UPDATE ON "provisionings"
    FOR EACH ROW EXECUTE FUNCTION velnox_assert_provisioning_tenant();

-- The new permissions, for installations that already ran setup. The catalogue
-- in packages/shared decides what a fresh installation seeds; this matches it.
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT r."id", 'autoconfig.read'
FROM "roles" r
WHERE r."is_system" AND r."tenant_id" IS NULL
ON CONFLICT ("role_id", "permission") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission")
SELECT r."id", 'autoconfig.manage'
FROM "roles" r
WHERE r."is_system"
  AND r."tenant_id" IS NULL
  AND r."key" IN ('msp_super_administrator', 'msp_administrator', 'msp_engineer', 'tenant_administrator')
ON CONFLICT ("role_id", "permission") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission")
SELECT r."id", 'workloads.provision'
FROM "roles" r
WHERE r."is_system"
  AND r."tenant_id" IS NULL
  AND r."key" IN ('msp_super_administrator', 'msp_administrator', 'msp_engineer', 'tenant_administrator', 'tenant_operator')
ON CONFLICT ("role_id", "permission") DO NOTHING;

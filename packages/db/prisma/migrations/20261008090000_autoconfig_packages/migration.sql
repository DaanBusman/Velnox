-- Installer packages per tenant (Phase 5C): MSIs and EXEs run in a Windows VM
-- after Setup, from a CD of their own.

CREATE TYPE "autoconfig_package_kind" AS ENUM ('MSI', 'EXE');
CREATE TYPE "autoconfig_package_state" AS ENUM ('RECEIVING', 'VERIFYING', 'READY', 'FAILED');

CREATE TABLE "autoconfig_packages" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "filename" TEXT NOT NULL,
    "kind" "autoconfig_package_kind" NOT NULL,
    "state" "autoconfig_package_state" NOT NULL DEFAULT 'RECEIVING',
    "size_bytes" BIGINT NOT NULL,
    "received_bytes" BIGINT NOT NULL DEFAULT 0,
    "sha256" TEXT,
    "job_id" UUID,
    "created_by_id" UUID,
    "created_by_label" TEXT,
    "error_code" TEXT,
    "error_detail" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "ready_at" TIMESTAMPTZ(3),

    CONSTRAINT "autoconfig_packages_pkey" PRIMARY KEY ("id"),
    -- 2 GiB, as PACKAGE_MAX_BYTES in packages/shared.
    CONSTRAINT "autoconfig_packages_size" CHECK ("size_bytes" BETWEEN 1 AND 2147483648),
    CONSTRAINT "autoconfig_packages_received" CHECK ("received_bytes" BETWEEN 0 AND "size_bytes")
);

CREATE INDEX "autoconfig_packages_tenant_id_idx" ON "autoconfig_packages"("tenant_id");
CREATE INDEX "autoconfig_packages_state_idx" ON "autoconfig_packages"("state");
-- One live package per name per tenant; a failed one does not hold its name.
CREATE UNIQUE INDEX "autoconfig_packages_tenant_filename"
    ON "autoconfig_packages"("tenant_id", lower("filename"))
    WHERE "state" <> 'FAILED';

ALTER TABLE "autoconfig_packages" ADD CONSTRAINT "autoconfig_packages_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

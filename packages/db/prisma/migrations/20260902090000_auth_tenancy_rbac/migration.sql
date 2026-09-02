-- CreateEnum
CREATE TYPE "tenant_kind" AS ENUM ('MSP_ROOT', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "tenant_status" AS ENUM ('ACTIVE', 'SUSPENDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "user_status" AS ENUM ('ACTIVE', 'DISABLED', 'INVITED');

-- CreateEnum
CREATE TYPE "identity_provider_kind" AS ENUM ('LOCAL', 'OIDC');

-- CreateEnum
CREATE TYPE "mfa_factor_kind" AS ENUM ('TOTP', 'WEBAUTHN');

-- CreateEnum
CREATE TYPE "scope_type" AS ENUM ('GLOBAL', 'TENANT', 'SITE', 'CLUSTER');

-- CreateEnum
CREATE TYPE "credential_kind" AS ENUM ('PVE_API_TOKEN', 'PVE_PASSWORD', 'SSH_PASSWORD', 'SSH_KEY', 'WINRM_PASSWORD', 'OIDC_CLIENT_SECRET', 'VMWARE_PASSWORD', 'TOTP_SEED');

-- CreateEnum
CREATE TYPE "credential_status" AS ENUM ('ACTIVE', 'PENDING', 'NEEDS_ATTENTION', 'REVOKED');

-- CreateEnum
CREATE TYPE "secret_status" AS ENUM ('PENDING', 'ACTIVE', 'SUPERSEDED', 'REVOKED');

-- CreateEnum
CREATE TYPE "actor_type" AS ENUM ('USER', 'API_TOKEN', 'SYSTEM', 'SCHEDULER', 'ANONYMOUS');

-- CreateEnum
CREATE TYPE "audit_result" AS ENUM ('SUCCESS', 'FAILURE', 'DENIED');

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "kind" "tenant_kind" NOT NULL DEFAULT 'CUSTOMER',
    "status" "tenant_status" NOT NULL DEFAULT 'ACTIVE',
    "parent_tenant_id" UUID,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "status" "user_status" NOT NULL DEFAULT 'ACTIVE',
    "password_hash" TEXT,
    "must_change_password" BOOLEAN NOT NULL DEFAULT false,
    "password_updated_at" TIMESTAMPTZ(3),
    "mfa_enrolled" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "timezone" TEXT,
    "token_version" INTEGER NOT NULL DEFAULT 0,
    "last_login_at" TIMESTAMPTZ(3),
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_providers" (
    "id" UUID NOT NULL,
    "kind" "identity_provider_kind" NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "discovery_url" TEXT,
    "issuer" TEXT,
    "client_id" TEXT,
    "client_secret_ref" UUID,
    "allowed_email_domains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "auto_provision" BOOLEAN NOT NULL DEFAULT false,
    "default_role_id" UUID,
    "default_tenant_id" UUID,
    "last_tested_at" TIMESTAMPTZ(3),
    "last_test_ok" BOOLEAN,
    "last_test_message" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "identity_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_identities" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "email_at_link" TEXT,
    "linked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_at" TIMESTAMPTZ(3),

    CONSTRAINT "user_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "family_id" UUID NOT NULL,
    "parent_id" UUID,
    "ip" TEXT,
    "user_agent" TEXT,
    "mfa_satisfied_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_reason" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_mfa_factors" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "mfa_factor_kind" NOT NULL DEFAULT 'TOTP',
    "label" TEXT,
    "secret_ref" UUID,
    "last_used_counter" BIGINT,
    "confirmed_at" TIMESTAMPTZ(3),
    "last_used_at" TIMESTAMPTZ(3),
    "disabled_at" TIMESTAMPTZ(3),
    "created_ip" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_mfa_factors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_recovery_codes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "used_at" TIMESTAMPTZ(3),
    "used_ip" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "msp_only" BOOLEAN NOT NULL DEFAULT false,
    "tenant_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" UUID NOT NULL,
    "permission" TEXT NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission")
);

-- CreateTable
CREATE TABLE "role_assignments" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "scope_type" "scope_type" NOT NULL,
    "scope_id" UUID,
    "tenant_id" UUID,
    "granted_by" UUID,
    "granted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3),

    CONSTRAINT "role_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credentials" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "kind" "credential_kind" NOT NULL,
    "label" TEXT,
    "status" "credential_status" NOT NULL DEFAULT 'ACTIVE',
    "scope_type" "scope_type",
    "scope_id" UUID,
    "username" TEXT,
    "realm" TEXT,
    "store_backend" TEXT NOT NULL DEFAULT 'DATABASE',
    "external_ref" TEXT,
    "last_verified_at" TIMESTAMPTZ(3),
    "last_rotated_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credential_secrets" (
    "id" UUID NOT NULL,
    "credential_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "secret_status" NOT NULL DEFAULT 'ACTIVE',
    "ciphertext" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "auth_tag" BYTEA NOT NULL,
    "wrapped_dek" BYTEA NOT NULL,
    "dek_iv" BYTEA NOT NULL,
    "dek_auth_tag" BYTEA NOT NULL,
    "key_version" INTEGER NOT NULL,
    "algorithm" TEXT NOT NULL,
    "aad" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activated_at" TIMESTAMPTZ(3),
    "superseded_at" TIMESTAMPTZ(3),
    "purge_after" TIMESTAMPTZ(3),

    CONSTRAINT "credential_secrets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenant_id" UUID,
    "actor_type" "actor_type" NOT NULL,
    "actor_id" UUID,
    "actor_label" TEXT,
    "impersonated_by" UUID,
    "action" TEXT NOT NULL,
    "resource_type" TEXT,
    "resource_id" TEXT,
    "resource_label" TEXT,
    "result" "audit_result" NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "request_id" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_tenant_id_idx" ON "users"("tenant_id");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE INDEX "user_identities_user_id_idx" ON "user_identities"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_identities_provider_id_subject_key" ON "user_identities"("provider_id", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_refresh_token_hash_key" ON "sessions"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_family_id_idx" ON "sessions"("family_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE INDEX "user_mfa_factors_user_id_idx" ON "user_mfa_factors"("user_id");

-- CreateIndex
CREATE INDEX "mfa_recovery_codes_user_id_idx" ON "mfa_recovery_codes"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_key_tenant_id_key" ON "roles"("key", "tenant_id");

-- CreateIndex
CREATE INDEX "role_assignments_user_id_idx" ON "role_assignments"("user_id");

-- CreateIndex
CREATE INDEX "role_assignments_tenant_id_idx" ON "role_assignments"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "role_assignments_user_id_role_id_scope_type_scope_id_key" ON "role_assignments"("user_id", "role_id", "scope_type", "scope_id");

-- CreateIndex
CREATE INDEX "credentials_tenant_id_idx" ON "credentials"("tenant_id");

-- CreateIndex
CREATE INDEX "credential_secrets_credential_id_idx" ON "credential_secrets"("credential_id");

-- CreateIndex
CREATE UNIQUE INDEX "credential_secrets_credential_id_version_key" ON "credential_secrets"("credential_id", "version");

-- CreateIndex
CREATE INDEX "audit_events_at_idx" ON "audit_events"("at");

-- CreateIndex
CREATE INDEX "audit_events_tenant_id_at_idx" ON "audit_events"("tenant_id", "at");

-- CreateIndex
CREATE INDEX "audit_events_actor_id_at_idx" ON "audit_events"("actor_id", "at");

-- CreateIndex
CREATE INDEX "audit_events_action_at_idx" ON "audit_events"("action", "at");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "identity_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_mfa_factors" ADD CONSTRAINT "user_mfa_factors_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credential_secrets" ADD CONSTRAINT "credential_secrets_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "credentials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Constraints that carry security weight
--
-- Prisma's schema language cannot express these, so they live here. Each turns
-- an invariant the application relies on into one the database enforces, so a
-- bug in application code cannot violate it.
-- ---------------------------------------------------------------------------

-- Exactly one MSP root tenant, ever. Created by the setup wizard; no code path
-- creates a second.
CREATE UNIQUE INDEX "tenants_single_msp_root"
    ON "tenants" ("kind")
    WHERE "kind" = 'MSP_ROOT';

-- One confirmed, enabled TOTP factor per user. An unconfirmed enrolment can
-- never shadow a working one, which is what stops a half-finished setup from
-- becoming the factor that locks someone out.
CREATE UNIQUE INDEX "user_mfa_factors_one_active_totp"
    ON "user_mfa_factors" ("user_id")
    WHERE "kind" = 'TOTP' AND "confirmed_at" IS NOT NULL AND "disabled_at" IS NULL;

-- Exactly one ACTIVE secret version per credential. Rotation writes a PENDING
-- version, applies it, verifies it, and only then promotes it.
CREATE UNIQUE INDEX "credential_secrets_one_active"
    ON "credential_secrets" ("credential_id")
    WHERE "status" = 'ACTIVE';

-- A GLOBAL grant has no scope id; every other scope must have one.
ALTER TABLE "role_assignments"
    ADD CONSTRAINT "role_assignments_scope_id_matches_type"
    CHECK (("scope_type" = 'GLOBAL') = ("scope_id" IS NULL));

-- A GLOBAL grant is only valid for a user whose home tenant is the MSP root.
-- A trigger rather than a CHECK, because it reads another table.
CREATE OR REPLACE FUNCTION velnox_assert_global_grant_is_msp()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."scope_type" = 'GLOBAL' THEN
        IF NOT EXISTS (
            SELECT 1
            FROM "users" u
            JOIN "tenants" t ON t."id" = u."tenant_id"
            WHERE u."id" = NEW."user_id" AND t."kind" = 'MSP_ROOT'
        ) THEN
            RAISE EXCEPTION
                'A GLOBAL role assignment requires the user to belong to the MSP root tenant';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "role_assignments_global_requires_msp"
    BEFORE INSERT OR UPDATE ON "role_assignments"
    FOR EACH ROW EXECUTE FUNCTION velnox_assert_global_grant_is_msp();

-- The audit log is append-only. Retention pruning runs as a separate database
-- role, so the application role cannot rewrite history even through SQL injection.
CREATE OR REPLACE FUNCTION velnox_audit_events_are_immutable()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'audit_events is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_events_no_update"
    BEFORE UPDATE ON "audit_events"
    FOR EACH ROW EXECUTE FUNCTION velnox_audit_events_are_immutable();

CREATE TRIGGER "audit_events_no_delete"
    BEFORE DELETE ON "audit_events"
    FOR EACH ROW EXECUTE FUNCTION velnox_audit_events_are_immutable();

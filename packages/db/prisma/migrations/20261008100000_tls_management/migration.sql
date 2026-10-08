-- Certificates chosen in Server management (Phase 5C, ADR-045).

CREATE TYPE "tls_mode" AS ENUM ('INTERNAL', 'ACME', 'CERTIFICATE');

ALTER TYPE "credential_kind" ADD VALUE 'TLS_PRIVATE_KEY';

ALTER TABLE "system_settings"
    ADD COLUMN "tls_mode" "tls_mode",
    ADD COLUMN "tls_acme_email" TEXT,
    ADD COLUMN "tls_acme_directory" TEXT,
    ADD COLUMN "tls_acme_ca_root" TEXT,
    ADD COLUMN "tls_certificate_pem" TEXT,
    ADD COLUMN "tls_key_credential_id" UUID,
    ADD COLUMN "tls_changed_at" TIMESTAMPTZ(3),
    ADD COLUMN "tls_changed_by" TEXT;

-- Each mode carries what it needs, and nothing a private key could hide in.
ALTER TABLE "system_settings"
    ADD CONSTRAINT "system_settings_tls_complete" CHECK (
        ("tls_mode" IS DISTINCT FROM 'ACME' OR "tls_acme_email" IS NOT NULL)
        AND ("tls_mode" IS DISTINCT FROM 'CERTIFICATE'
             OR ("tls_certificate_pem" IS NOT NULL AND "tls_key_credential_id" IS NOT NULL))
        AND ("tls_certificate_pem" IS NULL OR "tls_certificate_pem" NOT LIKE '%PRIVATE KEY%')
    );

-- Autoconfig: an MSP template offered to chosen tenants, and passwords per tenant.
--
-- The passwords per tenant need no column: each is one more TEMPLATE_SECRETS
-- credential, referenced from `secret_refs` as `tenant:<tenant id>:administrator`
-- or `…:root`. See ADR-039's amendment.

ALTER TYPE "template_visibility" ADD VALUE 'SELECTED' BEFORE 'PRIVATE';

ALTER TABLE "autoconfig_templates"
    ADD COLUMN "offered_tenant_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];

-- Compared as text: a value added to an enum cannot be used in the transaction
-- that added it, and this migration runs as one.
ALTER TABLE "autoconfig_templates"
    ADD CONSTRAINT "autoconfig_templates_offers_only_when_selected"
    CHECK ("visibility"::text = 'SELECTED' OR cardinality("offered_tenant_ids") = 0);

CREATE INDEX "autoconfig_templates_offered_tenant_ids_idx"
    ON "autoconfig_templates" USING GIN ("offered_tenant_ids");

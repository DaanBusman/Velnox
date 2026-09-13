-- Sites: a location inside a tenant.
--
-- Phase 3 gives tenancy a second level. A site is a datacentre, an office, a
-- colocation rack — somewhere infrastructure lives that is smaller than the
-- whole customer. Two things need it:
--
--   * a grant can be narrower than a tenant (scope_type = 'SITE'), so an
--     engineer responsible for one building does not inherit the other three;
--   * from Phase 4 a cluster hangs off a site rather than off the tenant, which
--     is what makes "everything in Amsterdam" answerable.

-- CreateTable
CREATE TABLE "sites" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "locality" TEXT,
    "country" CHAR(2),
    "timezone" TEXT,
    "contact_name" TEXT,
    "contact_email" TEXT,
    "contact_phone" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "sites_pkey" PRIMARY KEY ("id")
);

-- The slug is unique within a tenant rather than globally: two customers may
-- both perfectly reasonably have a site called "hq".
CREATE UNIQUE INDEX "sites_tenant_id_slug_key" ON "sites"("tenant_id", "slug");

CREATE INDEX "sites_tenant_id_idx" ON "sites"("tenant_id");

-- AddForeignKey
ALTER TABLE "sites" ADD CONSTRAINT "sites_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The tenant list is filtered by kind on every page that separates the MSP
-- organisation from its customers, and it is the first query the tenant selector
-- makes on every request.
CREATE INDEX "tenants_kind_idx" ON "tenants"("kind");

-- A grant at SITE scope must name a site that exists.
--
-- A trigger rather than a foreign key, because scope_id is polymorphic: it holds
-- a tenant id, a site id or a cluster id depending on scope_type, so no single
-- reference can be declared. Without this, a typo in a site id produces a grant
-- that silently covers nothing — which looks identical to a grant that has not
-- been given yet, and is the kind of thing discovered during an incident.
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
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "role_assignments_scope_target_exists"
    BEFORE INSERT OR UPDATE ON "role_assignments"
    FOR EACH ROW EXECUTE FUNCTION velnox_assert_scope_target_exists();

-- The denormalised tenant column has to agree with the scope.
--
-- `role_assignments.tenant_id` exists so a grant can be listed per tenant
-- without walking the scope chain, which means it is a copy of something — and a
-- copy that can disagree with its original is a bug waiting for a quiet
-- afternoon. Filled in here rather than trusted from the caller.
CREATE OR REPLACE FUNCTION velnox_role_assignment_tenant()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."scope_type" = 'GLOBAL' THEN
        NEW."tenant_id" := NULL;
    ELSIF NEW."scope_type" = 'TENANT' THEN
        NEW."tenant_id" := NEW."scope_id";
    ELSIF NEW."scope_type" = 'SITE' THEN
        SELECT "tenant_id" INTO NEW."tenant_id" FROM "sites" WHERE "id" = NEW."scope_id";
    END IF;
    -- CLUSTER scope is left alone: clusters arrive in Phase 4 and this function
    -- is replaced then rather than guessing at a table that does not exist yet.

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "role_assignments_tenant_follows_scope"
    BEFORE INSERT OR UPDATE ON "role_assignments"
    FOR EACH ROW EXECUTE FUNCTION velnox_role_assignment_tenant();

-- Main tenants and sub-tenants (Phase 5C).
--
-- A customer tenant is a main tenant (parent_tenant_id NULL) or a sub-tenant of
-- exactly one main tenant. Two levels under the MSP and no more: a sub-tenant
-- cannot have sub-tenants of its own, a main tenant with sub-tenants cannot
-- become one, and the MSP organisation is never anyone's parent or child. The
-- choice is made when the tenant is created and does not change afterwards —
-- moving a tenant would silently move every grant that reaches it.

ALTER TABLE "tenants"
    ADD CONSTRAINT "tenants_parent_tenant_id_fkey"
    FOREIGN KEY ("parent_tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "tenants_parent_tenant_id_idx" ON "tenants"("parent_tenant_id");

CREATE OR REPLACE FUNCTION velnox_assert_tenant_hierarchy()
RETURNS TRIGGER AS $$
DECLARE
    parent_kind "tenant_kind";
    parent_parent UUID;
BEGIN
    IF TG_OP = 'UPDATE' AND NEW."parent_tenant_id" IS DISTINCT FROM OLD."parent_tenant_id" THEN
        RAISE EXCEPTION 'A tenant''s main tenant is chosen when it is created and does not change';
    END IF;

    IF NEW."parent_tenant_id" IS NULL THEN
        RETURN NEW;
    END IF;

    IF NEW."kind" <> 'CUSTOMER' THEN
        RAISE EXCEPTION 'Only a customer tenant can be a sub-tenant';
    END IF;
    IF NEW."parent_tenant_id" = NEW."id" THEN
        RAISE EXCEPTION 'A tenant cannot be its own main tenant';
    END IF;

    SELECT "kind", "parent_tenant_id" INTO parent_kind, parent_parent
      FROM "tenants" WHERE "id" = NEW."parent_tenant_id";
    IF parent_kind IS DISTINCT FROM 'CUSTOMER' THEN
        RAISE EXCEPTION 'A sub-tenant belongs to a customer main tenant';
    END IF;
    IF parent_parent IS NOT NULL THEN
        RAISE EXCEPTION 'A sub-tenant cannot have sub-tenants of its own';
    END IF;
    IF EXISTS (SELECT 1 FROM "tenants" WHERE "parent_tenant_id" = NEW."id") THEN
        RAISE EXCEPTION 'A main tenant with sub-tenants cannot become a sub-tenant';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tenants_hierarchy_two_levels"
    BEFORE INSERT OR UPDATE ON "tenants"
    FOR EACH ROW EXECUTE FUNCTION velnox_assert_tenant_hierarchy();

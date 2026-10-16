-- Custom roles (ADR-054): made by the MSP, installation-wide like the system
-- roles (tenant_id NULL, so a customer's session can see a role it may be
-- given), told apart by is_system = false.

-- A role's key is unique among installation-wide roles. The existing unique
-- index is on (key, tenant_id), which NULL tenant ids never collide in.
CREATE UNIQUE INDEX "roles_key_installation_key" ON "roles"("key") WHERE "tenant_id" IS NULL;

-- An MSP-only role is only ever held by an account in the MSP organisation.
-- The API refused this only when the person granting was outside the MSP —
-- the account receiving it was never checked, and the trigger the API's
-- comment relied on did not exist. Now it does.
CREATE OR REPLACE FUNCTION velnox_assert_msp_only_role_is_msp()
RETURNS TRIGGER AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM "roles" r WHERE r."id" = NEW."role_id" AND r."msp_only") THEN
        IF NOT EXISTS (
            SELECT 1
            FROM "users" u
            JOIN "tenants" t ON t."id" = u."tenant_id"
            WHERE u."id" = NEW."user_id" AND t."kind" = 'MSP_ROOT'
        ) THEN
            RAISE EXCEPTION
                'An MSP-only role can only be assigned to a user of the MSP root tenant';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "role_assignments_msp_only_role_requires_msp"
    BEFORE INSERT OR UPDATE ON "role_assignments"
    FOR EACH ROW EXECUTE FUNCTION velnox_assert_msp_only_role_is_msp();

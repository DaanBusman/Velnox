-- Audit retention per tenant, and the one way old audit events may go.
--
-- The audit log stays append-only. What changes is that events older than a
-- tenant's retention may be removed — only through velnox_prune_audit_events,
-- which the worker's retention sweep calls and which refuses anything younger
-- than a year. An ordinary DELETE is refused exactly as before, and an UPDATE
-- always is. NULL retention, the default, keeps everything for ever.

ALTER TABLE "tenants" ADD COLUMN "audit_retention_days" INTEGER;
ALTER TABLE "tenants"
    ADD CONSTRAINT "tenants_audit_retention_at_least_a_year"
    CHECK ("audit_retention_days" IS NULL OR "audit_retention_days" >= 365);

CREATE OR REPLACE FUNCTION velnox_audit_events_are_immutable()
RETURNS TRIGGER AS $$
BEGIN
    -- Set, transaction-locally, only inside velnox_prune_audit_events.
    IF TG_OP = 'DELETE' AND current_setting('velnox.audit_prune', true) = 'on' THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'audit_events is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

-- Remove one tenant's events older than p_before; with p_include_unowned, also
-- the events that belong to no tenant (installation-wide ones, which follow the
-- MSP organisation's retention). Returns how many went.
CREATE OR REPLACE FUNCTION velnox_prune_audit_events(
    p_tenant_id UUID,
    p_include_unowned BOOLEAN,
    p_before TIMESTAMPTZ
)
RETURNS INTEGER AS $$
DECLARE
    removed INTEGER;
BEGIN
    IF p_before > now() - INTERVAL '365 days' THEN
        RAISE EXCEPTION 'audit events younger than a year are never pruned';
    END IF;
    PERFORM set_config('velnox.audit_prune', 'on', true);
    DELETE FROM "audit_events"
     WHERE "at" < p_before
       AND ("tenant_id" = p_tenant_id OR (p_include_unowned AND "tenant_id" IS NULL));
    GET DIAGNOSTICS removed = ROW_COUNT;
    PERFORM set_config('velnox.audit_prune', 'off', true);
    RETURN removed;
END;
$$ LANGUAGE plpgsql;

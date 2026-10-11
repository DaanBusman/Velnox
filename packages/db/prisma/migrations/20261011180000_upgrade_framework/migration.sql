-- The major upgrade framework (Phase 8): plans, their targets, the findings of
-- each run of their checks, and remediations with the exact change each made.

-- CreateEnum
CREATE TYPE "upgrade_plan_kind" AS ENUM ('PVE_MAJOR', 'CEPH', 'COMPOSITE', 'SELFTEST');

-- CreateEnum
CREATE TYPE "upgrade_plan_status" AS ENUM ('DRAFT', 'RUNNING', 'WAITING_APPROVAL', 'BLOCKED', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "upgrade_target_kind" AS ENUM ('NODE', 'CEPH_DAEMON');

-- CreateEnum
CREATE TYPE "check_severity" AS ENUM ('PASS', 'INFO', 'WARNING', 'BLOCKER', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "remediation_mode" AS ENUM ('AUTOMATIC', 'APPROVED');

-- CreateEnum
CREATE TYPE "remediation_status" AS ENUM ('PLANNED', 'APPLIED', 'VALIDATED', 'FAILED', 'ROLLED_BACK');

-- CreateTable
CREATE TABLE "upgrade_plans" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "cluster_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "upgrade_plan_kind" NOT NULL,
    "playbook_id" TEXT,
    "playbook_version" INTEGER,
    "parent_plan_id" UUID,
    "sequence" INTEGER NOT NULL DEFAULT 1,
    "status" "upgrade_plan_status" NOT NULL DEFAULT 'DRAFT',
    "options" JSONB NOT NULL DEFAULT '{}',
    "facts" JSONB NOT NULL DEFAULT '{}',
    "job_id" UUID,
    "report" JSONB,
    "created_by_user_id" UUID,
    "created_by_label" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "upgrade_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upgrade_targets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "target_kind" "upgrade_target_kind" NOT NULL,
    "node_id" UUID,
    "ceph_daemon_id" UUID,
    "label" TEXT NOT NULL,
    "daemon_group" TEXT,
    "sequence" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "pre_state" JSONB,
    "post_state" JSONB,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "upgrade_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upgrade_checks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "target_id" UUID,
    "source" TEXT NOT NULL,
    "parser_version" INTEGER NOT NULL DEFAULT 1,
    "check_key" TEXT NOT NULL,
    "severity" "check_severity" NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "raw_line" TEXT,
    "remediation_id" TEXT,
    "run_index" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "upgrade_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "remediation_runs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "job_id" UUID,
    "target_id" UUID,
    "check_key" TEXT NOT NULL,
    "remediation_id" TEXT NOT NULL,
    "risk" TEXT NOT NULL,
    "mode" "remediation_mode" NOT NULL,
    "change_set" JSONB NOT NULL,
    "status" "remediation_status" NOT NULL DEFAULT 'PLANNED',
    "applied_at" TIMESTAMPTZ(3),
    "validated_at" TIMESTAMPTZ(3),
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "remediation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "upgrade_plans_tenant_id_idx" ON "upgrade_plans"("tenant_id");

-- CreateIndex
CREATE INDEX "upgrade_plans_cluster_id_idx" ON "upgrade_plans"("cluster_id");

-- CreateIndex
CREATE INDEX "upgrade_plans_parent_plan_id_idx" ON "upgrade_plans"("parent_plan_id");

-- CreateIndex
CREATE INDEX "upgrade_targets_tenant_id_idx" ON "upgrade_targets"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "upgrade_targets_plan_id_sequence_key" ON "upgrade_targets"("plan_id", "sequence");

-- CreateIndex
CREATE INDEX "upgrade_checks_tenant_id_idx" ON "upgrade_checks"("tenant_id");

-- CreateIndex
CREATE INDEX "upgrade_checks_plan_id_run_index_idx" ON "upgrade_checks"("plan_id", "run_index");

-- CreateIndex
CREATE INDEX "remediation_runs_tenant_id_idx" ON "remediation_runs"("tenant_id");

-- CreateIndex
CREATE INDEX "remediation_runs_plan_id_idx" ON "remediation_runs"("plan_id");

-- AddForeignKey
ALTER TABLE "upgrade_plans" ADD CONSTRAINT "upgrade_plans_cluster_id_fkey" FOREIGN KEY ("cluster_id") REFERENCES "clusters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upgrade_plans" ADD CONSTRAINT "upgrade_plans_parent_plan_id_fkey" FOREIGN KEY ("parent_plan_id") REFERENCES "upgrade_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upgrade_targets" ADD CONSTRAINT "upgrade_targets_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "upgrade_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upgrade_checks" ADD CONSTRAINT "upgrade_checks_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "upgrade_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remediation_runs" ADD CONSTRAINT "remediation_runs_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "upgrade_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A target is a node or a Ceph daemon, never both and never neither.
ALTER TABLE "upgrade_targets" ADD CONSTRAINT "upgrade_targets_one_kind" CHECK (
    ("target_kind" = 'NODE' AND "ceph_daemon_id" IS NULL)
    OR ("target_kind" = 'CEPH_DAEMON' AND "node_id" IS NULL)
);
-- A composite has children and no playbook; any other plan has a playbook.
ALTER TABLE "upgrade_plans" ADD CONSTRAINT "upgrade_plans_playbook" CHECK (
    ("kind" = 'COMPOSITE') = ("playbook_id" IS NULL)
);

-- A plan belongs to its cluster's tenant; a child to its parent's cluster; and
-- everything under a plan to the plan's tenant. Never trusted from the caller.
CREATE OR REPLACE FUNCTION velnox_upgrade_plan_owner()
RETURNS TRIGGER AS $$
DECLARE
    parent_cluster UUID;
BEGIN
    SELECT "tenant_id" INTO NEW."tenant_id" FROM "clusters" WHERE "id" = NEW."cluster_id";
    IF NEW."parent_plan_id" IS NOT NULL THEN
        SELECT "cluster_id" INTO parent_cluster FROM "upgrade_plans" WHERE "id" = NEW."parent_plan_id";
        IF parent_cluster IS DISTINCT FROM NEW."cluster_id" THEN
            RAISE EXCEPTION 'A child plan upgrades its parent''s cluster';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "upgrade_plans_owner_follows_cluster"
    BEFORE INSERT OR UPDATE ON "upgrade_plans"
    FOR EACH ROW EXECUTE FUNCTION velnox_upgrade_plan_owner();

CREATE OR REPLACE FUNCTION velnox_upgrade_child_owner()
RETURNS TRIGGER AS $$
BEGIN
    SELECT "tenant_id" INTO NEW."tenant_id" FROM "upgrade_plans" WHERE "id" = NEW."plan_id";
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "upgrade_targets_owner_follows_plan"
    BEFORE INSERT OR UPDATE ON "upgrade_targets"
    FOR EACH ROW EXECUTE FUNCTION velnox_upgrade_child_owner();
CREATE TRIGGER "upgrade_checks_owner_follows_plan"
    BEFORE INSERT OR UPDATE ON "upgrade_checks"
    FOR EACH ROW EXECUTE FUNCTION velnox_upgrade_child_owner();
CREATE TRIGGER "remediation_runs_owner_follows_plan"
    BEFORE INSERT OR UPDATE ON "remediation_runs"
    FOR EACH ROW EXECUTE FUNCTION velnox_upgrade_child_owner();

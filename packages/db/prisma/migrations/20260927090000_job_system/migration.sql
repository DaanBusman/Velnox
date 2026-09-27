-- Phase 5: the job system.
--
-- docs/database-schema.md section 6, docs/architecture.md section 9. The tables
-- below are generated from schema.prisma; the three blocks after them are not,
-- because Prisma has no way to express them, and each one is a rule the
-- application must not be trusted to keep on its own.

-- CreateEnum
CREATE TYPE "job_status" AS ENUM ('QUEUED', 'PREFLIGHT', 'WAITING_APPROVAL', 'RUNNING', 'VALIDATING', 'SUCCEEDED', 'PARTIALLY_SUCCEEDED', 'FAILED', 'ROLLED_BACK', 'CANCELLED');

-- CreateEnum
CREATE TYPE "job_step_status" AS ENUM ('PENDING', 'RUNNING', 'SKIPPED', 'SUCCEEDED', 'FAILED', 'ROLLED_BACK');

-- CreateEnum
CREATE TYPE "job_event_level" AS ENUM ('DEBUG', 'INFO', 'WARN', 'ERROR');

-- CreateEnum
CREATE TYPE "job_log_stream" AS ENUM ('STDOUT', 'STDERR', 'PVE_TASK');

-- CreateEnum
CREATE TYPE "approval_decision" AS ENUM ('APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "playbook_version" INTEGER NOT NULL DEFAULT 1,
    "status" "job_status" NOT NULL DEFAULT 'QUEUED',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "created_by_user_id" UUID,
    "target_kind" TEXT,
    "target_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "params" JSONB NOT NULL DEFAULT '{}',
    "concurrency_key" TEXT,
    "progress_pct" INTEGER,
    "current_phase" TEXT,
    "current_step" TEXT,
    "queued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "error_code" TEXT,
    "error_message" TEXT,
    "result_summary" JSONB,
    "parent_job_id" UUID,
    "cancel_requested_at" TIMESTAMPTZ(3),
    "cancel_requested_by" UUID,
    "worker_id" TEXT,
    "lease_until" TIMESTAMPTZ(3),
    "event_seq" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_steps" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "node_id" UUID,
    "phase" TEXT,
    "step_key" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "status" "job_step_status" NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "output" JSONB,
    "error" TEXT,

    CONSTRAINT "job_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_events" (
    "id" BIGSERIAL NOT NULL,
    "job_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" "job_event_level" NOT NULL,
    "event_key" TEXT NOT NULL,
    "step_key" TEXT,
    "message" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "status" "job_status" NOT NULL,
    "progress_pct" INTEGER,

    CONSTRAINT "job_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_logs" (
    "id" BIGSERIAL NOT NULL,
    "job_id" UUID NOT NULL,
    "step_key" TEXT,
    "stream" "job_log_stream" NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "content" TEXT NOT NULL,
    "truncated" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "job_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approvals" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "step_key" TEXT NOT NULL,
    "required_permission" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "change_set" JSONB NOT NULL DEFAULT '{}',
    "require_different_approver" BOOLEAN NOT NULL DEFAULT false,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3),
    "decided_at" TIMESTAMPTZ(3),
    "decided_by_user_id" UUID,
    "decision" "approval_decision",
    "decision_note" TEXT,

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "jobs_tenant_id_queued_at_idx" ON "jobs"("tenant_id", "queued_at");

-- CreateIndex
CREATE INDEX "jobs_status_idx" ON "jobs"("status");

-- CreateIndex
CREATE INDEX "jobs_type_queued_at_idx" ON "jobs"("type", "queued_at");

-- CreateIndex
CREATE UNIQUE INDEX "job_steps_job_id_sequence_key" ON "job_steps"("job_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "job_steps_job_id_step_key_key" ON "job_steps"("job_id", "step_key");

-- CreateIndex
CREATE UNIQUE INDEX "job_events_job_id_seq_key" ON "job_events"("job_id", "seq");

-- CreateIndex
CREATE INDEX "job_logs_job_id_id_idx" ON "job_logs"("job_id", "id");

-- CreateIndex
CREATE INDEX "approvals_job_id_idx" ON "approvals"("job_id");

-- CreateIndex
CREATE INDEX "approvals_tenant_id_requested_at_idx" ON "approvals"("tenant_id", "requested_at");

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_parent_job_id_fkey" FOREIGN KEY ("parent_job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_steps" ADD CONSTRAINT "job_steps_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_logs" ADD CONSTRAINT "job_logs_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- One active job per concurrency key.
--
-- This is what stops two mutating jobs touching one cluster at the same time.
-- The API checks first and says why, but two API instances can both check and
-- both find nothing; only the database sees both inserts. The state list must
-- equal ACTIVE_JOB_STATUSES in packages/shared/src/jobs.ts, and a test reads
-- this file to make sure it does.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "jobs_one_active_per_key"
    ON "jobs" ("concurrency_key")
    WHERE "concurrency_key" IS NOT NULL
      AND "status" IN ('QUEUED', 'PREFLIGHT', 'WAITING_APPROVAL', 'RUNNING', 'VALIDATING');

-- ---------------------------------------------------------------------------
-- An approval belongs to its job's tenant, always.
--
-- Set rather than checked: whatever the caller supplied is replaced with the
-- job's own tenant. An approval row is what a tenant-scoped grant is checked
-- against, so an approval carrying the wrong tenant would let one customer's
-- operator decide another customer's change.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION velnox_approval_tenant()
RETURNS TRIGGER AS $$
BEGIN
    SELECT "tenant_id" INTO NEW."tenant_id" FROM "jobs" WHERE "id" = NEW."job_id";
    IF NEW."tenant_id" IS NULL THEN
        RAISE EXCEPTION 'approval refers to job % which does not exist', NEW."job_id";
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "approvals_tenant_follows_job"
    BEFORE INSERT OR UPDATE ON "approvals"
    FOR EACH ROW EXECUTE FUNCTION velnox_approval_tenant();

-- ---------------------------------------------------------------------------
-- Events are history.
--
-- A job's event stream is what an operator reads to find out what happened,
-- and what a reconnecting browser replays by sequence number. Rewriting one
-- would change both. Deletion stays possible — it arrives with a retention
-- policy, and cascades from a job — but an event, once written, says what it
-- said.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION velnox_job_events_immutable()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'job_events rows are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "job_events_no_update"
    BEFORE UPDATE ON "job_events"
    FOR EACH ROW EXECUTE FUNCTION velnox_job_events_immutable();

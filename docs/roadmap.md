# Velnox — Implementation Roadmap

**Status:** Phase 0 complete (this document set). Phases 1–15 await approval.

Every phase ends with the same gate. A phase is **not** finished until all of these are true:

1. `pnpm lint` and `pnpm typecheck` pass with zero errors.
2. `pnpm test` passes, including the phase's new tests.
3. `docker compose up --build` starts the full stack and every health check is green.
4. The phase's acceptance criteria are demonstrably met — verified by running it, not by assertion.
5. The relevant `docs/*.md` files are updated.
6. Work is committed in logically separated commits.
7. Anything incomplete is behind a feature flag and listed in `docs/known-gaps.md` — never shown as
   working UI.

Effort estimates are relative sizes (S/M/L/XL), not calendar promises.

---

## Phase 1 — Monorepo bootstrap and running stack · **L**

pnpm workspaces, Turborepo, shared TS/ESLint/Prettier configs. NestJS api skeleton with
`/healthz`, `/readyz`, OpenAPI, global validation pipe, error filter, pino logging with redaction.
Next.js web skeleton with the sidebar shell, dark mode and the BFF proxy. Prisma package with the
initial migration (`system_settings` only). Redis + BullMQ wiring with a trivial ping job. Compose
files for dev and prod, Caddy, health checks, dependency ordering, named volumes. `.env.example`
with every variable documented. CI running lint, typecheck, test and build.

**Acceptance:** `docker compose up --build` on a clean machine brings up six healthy services;
`https://localhost` serves the shell; `/api/v1/health` responds through Caddy; a queued ping job is
processed by the worker and its completion is visible; `/api/docs` serves OpenAPI.

## Phase 2 — Authentication, setup wizard, RBAC core · **XL**

Argon2id hashing, JWT access + rotating refresh with reuse detection, CSRF double-submit, rate
limiting, secure headers. Setup wizard: `GET /setup/status`, `POST /setup/initialize` creating the
MSP root tenant, system roles and the first Super Administrator in one transaction, then permanently
closed. Permission catalogue, roles, role assignments, `RequestContext`, `@RequirePermission` guard
with scope resolution. Login/logout/refresh/me endpoints and UI. Audit events for auth actions.
Entra ID OIDC scaffolding: configuration model, discovery validation, "test connection", login
button behind a feature flag.

**Acceptance:** a fresh install shows the wizard, refuses a weak password, creates exactly one
admin, and returns 409 on a second attempt; no default credentials exist anywhere; login/logout
work; an expired access token refreshes transparently; a replayed refresh token kills the session
family; a user without a permission gets 403 and the denial is audited; the permission matrix test
suite passes.

## Phase 3 — Multi-tenancy · **L**

Tenants and sites CRUD. Prisma tenancy extension with the throw-on-missing-context rule and the
explicit `withSystemScope()` escape. Scope-aware role assignments (GLOBAL/TENANT/SITE/CLUSTER).
Tenant selector in the top bar (server-validated, never trusted from the client). Cross-tenant test
harness.

**Acceptance:** MSP root users see and manage all tenants; a tenant admin sees only their own and
cannot enumerate others; the isolation suite passes for read **and** write across every tenant-scoped
resource that exists at this point, including list endpoints, filters and direct-ID access;
querying a tenant-scoped model without a context throws in tests.

## Phase 4 — Proxmox integration and inventory · **XL**

`packages/proxmox` with token and ticket auth, TLS fingerprint pinning, retries and the UPID task
poller. `packages/crypto` with envelope encryption and `DatabaseSecretStore`. Add cluster / add
standalone node flows including the fingerprint confirmation step. Discovery of cluster status,
quorum, nodes, versions, repositories, subscription, storage, network, Ceph status and workloads.
Inventory tables and UI: cluster list, node list with health/version/updates columns, node detail
page, VM/container inventory. Scheduled discovery via repeatable jobs.

**Acceptance:** a real (or fixture-backed) cluster can be added with an API token; certificate
pinning is enforced and a mismatch fails closed; node and workload inventory populate and refresh on
schedule; PVE version and health are visible in the UI; credentials are stored encrypted and no
endpoint returns plaintext material; discovery of an unreachable node produces a recorded error, not
a silent success.

## Phase 5 — Job system · **L**

Job state machine, `job_steps`, `job_events`, `job_logs`, approvals. SSE stream with Redis pub/sub.
Cancellation flags and `AbortSignal` plumbing. Crash reconciliation on worker start. Concurrency
keys. Jobs UI: list, filters, detail with live event stream, cancel, retry.

**Acceptance:** a long-running job streams progress live to the browser; cancelling stops it at the
next safe boundary and records `CANCELLED`; killing the worker mid-job leaves the job reconciled to
`FAILED` with `worker_lost`, not stuck in `RUNNING`; two mutating jobs against one cluster cannot run
concurrently; every invalid state transition throws.

## Phase 6 — Update management · **M**

Update inventory per node (security / kernel / Proxmox classification), reboot-required detection,
update policies, maintenance windows (RRULE), single-node update execution, update history.

**Acceptance:** pending updates are listed per node and correctly classified; a single-node update
runs as a job with live output; reboot-required is detected and surfaced; a policy with a
maintenance window does not execute outside it; manual-approval policy parks the job in
`waiting_approval`.

## Phase 7 — Rolling updates · **L**

Cluster-aware orchestration: quorum/Ceph/capacity guards, workload migratability assessment, live
migration where possible, maintenance mode, reboot, wait-for-return, post-checks, then the next node.
Configurable concurrency with the central safety invariant.

**Acceptance:** a rolling update on a 3-node cluster updates nodes strictly one at a time by default;
the run refuses to start on an already-degraded cluster; the quorum invariant holds under property
tests for cluster sizes 1–15; a node failing post-validation stops the run and reports
`partially_succeeded`; workloads are migrated back or accounted for explicitly.

## Phase 8 — Major upgrade framework (generic) · **L**

Playbook engine, step registry, guard evaluator, phase model (Discovery → Preflight → Remediation →
Re-check → Upgrade → Validation → Report). Upgrade plans and targets. Remediation plugin interface
and registry with `ChangeSet` planning, approval routing and rollback. Report generation.

**Acceptance:** a playbook is defined as data and executed by the generic runner; a second, trivial
playbook (e.g. PBS package refresh) runs on the same engine with no engine changes — this is the
proof of genericity; remediation metadata drives automatic-vs-approval routing; reports render.

## Phase 9 — PVE 8 → 9 workflow · **L**

The concrete playbook. `pve8to9` execution and versioned parser with golden-file tests. Repository
remediations (bookworm → trixie, deprecated repo handling, enterprise/no-subscription), package
remediations, storage/network blocker detection. Canary-first node ordering. Post-upgrade validation
against PVE 9 expectations.

**Acceptance:** preflight produces structured PASS/WARNING/BLOCKER/UNKNOWN with raw output retained;
unknown lines are treated as blockers; a safe repository remediation applies, validates and triggers
an automatic re-check; an unsafe remediation halts for approval showing the exact diff; blockers can
never be bypassed by a UI action; the report contains before/after node state.

## Phase 10 — Credential rotation · **M**

Password generation, crash-safe PENDING → apply → verify → ACTIVE ordering, `chpasswd` over SSH
stdin, verification with a fresh connection, rotation policies and schedules, per tenant/cluster/node
scoping, `NEEDS_ATTENTION` handling and alerting.

**Acceptance:** rotation completes and the new password authenticates; a simulated failure between
apply and verify leaves both versions retained and the credential flagged, never deleted; the full
job event stream, logs, audit metadata and every API response are asserted to contain no substring
of the generated password; break-glass reveal is a separate, heavily audited permission.

## Phase 11 — VMware migration assistant · **L**

vCenter/ESXi adapter, discovery, compatibility assessment, target selection wizard, plan generation,
and orchestration of PVE native ESXi import where available.

**Acceptance:** hosts and VMs are discovered with CPU/RAM/disk/NIC/tools/power detail;
incompatibilities (UEFI, vTPM, RDM, snapshots, drivers) are shown explicitly; a plan is generated
with target cluster/node/storage/bridge mapping; on PVE ≥ 8.2 an import runs as a tracked job; below
8.2 the UI states the limitation instead of offering a button that cannot work.

## Phase 12 — Hyper-V migration assistant · **M**

WinRM adapter, read-only PowerShell discovery, VHDX detection, generation/firmware/dynamic-memory
assessment, plan generation, `qemu-img` conversion workflow with a clearly labelled
operator-assisted transfer step.

**Acceptance:** hosts and VMs are discovered including VHDX paths, generation and NICs;
compatibility warnings are explicit; a plan can be produced and its automatable steps execute as
jobs; steps requiring operator action are labelled as such and never report success on their own.

## Phase 13 — UI polish · **M**

Dashboard tiles, global search, notifications, bulk actions, saved filters, detail drawers,
breadcrumbs, empty and error states, keyboard navigation, accessibility pass, dark-mode audit,
responsive behaviour.

**Acceptance:** every sidebar item in the brief resolves to a real page backed by real data or an
honest empty state; the dashboard shows the specified counters; bulk actions respect permissions
per item; contrast and focus order pass an a11y audit.

## Phase 14 — Installer and build artifacts · **L**

`install.sh` (interactive and `--non-interactive`), Docker/Compose auto-install, secret generation,
idempotent re-run, migrations, health verification, final URL output. `uninstall.sh` with explicit
data-deletion confirmation. `scripts/build.sh` targets `tar`, `installer`, `iso`, `dev`, `all`.
Checksums and a manifest. live-build ISO pipeline with an honest preflight.

**Acceptance:** a clean Debian 12 VM without Docker goes from `./install.sh` to a working login page
in one command; re-running preserves `.env` and data; the tar.gz unpacks and installs on a second
host; `uninstall.sh` never deletes volumes without explicit confirmation; the ISO either builds and
boots into an installer that produces a working appliance, or fails with a clear message — never a
placeholder file.

## Phase 15 — Security review, tests, documentation · **L**

Threat model, `docs/security.md`, dependency and container scanning, secure-header verification,
optional PostgreSQL RLS hardening, rate-limit tuning, backup/restore drill, key-rotation drill.
Complete the documentation set. Fill test coverage gaps.

**Acceptance:** the full test suite passes in CI including tenant isolation, RBAC matrix, redaction
and quorum invariants; a documented restore-from-backup drill succeeds on a fresh host; a
master-key rotation drill succeeds; `docs/known-gaps.md` accurately lists every remaining
limitation.

---

## Delivery order rationale

Phases 2–3 come before any Proxmox work because tenancy and RBAC are boundaries that are painful to
retrofit — every later table and endpoint inherits them. Phase 5 (jobs) precedes updates and
upgrades because both are jobs; building them first would mean building the state machine twice.
Phase 8 (generic framework) precedes Phase 9 (concrete PVE 8→9) so genericity is proven by
construction rather than claimed afterwards. The installer lands at Phase 14 because it packages
whatever exists — but the compose stack from Phase 1 is continuously runnable, so there is never a
period where the product cannot be started.

## Cross-cutting work carried in every phase

Audit events for every new mutating action; OpenAPI kept current; tenancy and permission tests
alongside each new resource; `.env.example` updated with any new variable; `docs/known-gaps.md`
updated when something ships incomplete.

---

*Velnox™ is a trademark of The Velnox Foundation.*

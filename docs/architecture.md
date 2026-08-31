# Velnox — Architecture

> Velnox is a self-hosted MSP management platform for Proxmox VE fleets.
> Velnox™ is a trademark of **The Velnox Foundation**.

**Status:** Phase 0 — design proposal. No implementation code exists yet.
**Document version:** 0.1.0
**Target platform:** Debian 12 (bookworm) / Debian 13 (trixie), x86_64, Docker + Docker Compose.

---

## 1. Scope and design goals

Velnox centrally manages many *independent* Proxmox VE environments belonging to many
*independent* customers of one MSP. That single sentence drives every architectural choice:

| Goal | Consequence |
|---|---|
| Multiple customers on one installation | Hard, server-side multi-tenancy; isolation is a security boundary, not a UI filter |
| Operations against live production hypervisors | Every mutating action is an auditable, resumable, cancellable job — never an inline HTTP handler |
| Root-level credentials for third-party infrastructure | Envelope-encrypted secret store with a pluggable backend; secrets never reach logs, job output, or the browser |
| Destructive workflows (major upgrades, reboots) | Data-driven playbooks with preflight → remediation → re-check → execute → validate, and explicit approval gates |
| Delivered as an appliance | Reproducible build pipeline: dev compose → tar.gz bundle → self-extracting installer → Debian ISO |
| Vendors will change (VMware, Hyper-V, Vault, future PVE versions) | Everything external sits behind an adapter interface with a registry |

### Non-goals for v1 (explicitly out of scope, documented so nobody assumes otherwise)

- Velnox is **not** a monitoring/metrics TSDB. It records point-in-time inventory and health,
  not high-resolution time series. Long-term metrics remain a future Prometheus integration.
- Velnox does **not** replace Proxmox Backup Server. It orchestrates; it does not store VM data.
- Velnox does **not** perform Ceph major-version upgrades in v1. The upgrade framework is built
  generically so a Ceph playbook can be added later, but no Ceph upgrade playbook ships in v1.
- Velnox does **not** provide a customer-facing self-service portal in v1. Tenant users are
  operators, not end customers.

---

## 2. System overview

```
                        ┌──────────────────────────────┐
   Browser  ──HTTPS──►  │  reverse-proxy (Caddy)       │
                        │  TLS, HSTS, security headers │
                        └──────┬───────────────┬───────┘
                               │ /             │ /api/v1
                               ▼               ▼
                     ┌───────────────┐   ┌──────────────────┐
                     │ web (Next.js) │   │ api (NestJS)     │
                     │ SSR + BFF     │──►│ REST + SSE       │
                     └───────────────┘   └───┬──────┬───────┘
                                             │      │
                            ┌────────────────┘      └────────────┐
                            ▼                                    ▼
                     ┌─────────────┐                      ┌─────────────┐
                     │ PostgreSQL  │                      │   Redis     │
                     │ system of   │◄─────────────────────│ queue +     │
                     │ record      │                      │ pub/sub     │
                     └─────────────┘                      └──────┬──────┘
                            ▲                                    │
                            └────────────────┐      ┌────────────┘
                                             │      ▼
                                        ┌────┴──────────────┐
                                        │ worker (NestJS)   │
                                        │ BullMQ processors │
                                        └────┬──────────────┘
                                             │
                       ┌─────────────────────┼──────────────────────┐
                       ▼                     ▼                      ▼
              ┌────────────────┐   ┌──────────────────┐   ┌──────────────────┐
              │ Proxmox HTTPS  │   │ SSH (ssh2)       │   │ VMware / Hyper-V │
              │ API :8006      │   │ root@node        │   │ REST / WinRM     │
              └────────────────┘   └──────────────────┘   └──────────────────┘
```

Full service diagram, ports, health checks and dependency ordering: [service-diagram.md](service-diagram.md).

### Why this split

- **api** owns HTTP, authn/authz, validation and job *submission*. It never talks to a Proxmox
  node, never opens an SSH connection, never runs a shell command. This is a deliberate security
  boundary: a request handler cannot be tricked into remote execution because it has no code path
  to it.
- **worker** owns all outbound infrastructure automation. It is the only container with the
  Proxmox/SSH/WinRM adapters loaded and the only one that decrypts credentials for use.
- **web** is a thin BFF. The browser never holds a token: the session cookie is `HttpOnly`,
  `SameSite=Lax`, same-origin, and Next.js proxies to the api over the internal Docker network.
- **PostgreSQL is the system of record** for jobs. Redis is the *transport*. If Redis is wiped, no
  job history, audit trail or approval decision is lost — only in-flight scheduling, which is
  reconciled on worker start.

---

## 3. Monorepo layout

```
velnox/
├─ apps/
│  ├─ api/                     # NestJS HTTP API (REST + SSE), no outbound automation
│  │  ├─ src/modules/          # auth, users, tenants, sites, rbac, clusters, nodes,
│  │  │                        # vms, updates, upgrades, migrations, jobs, audit,
│  │  │                        # alerts, settings, setup
│  │  ├─ src/common/           # guards, interceptors, filters, pipes, request-context
│  │  └─ test/                 # e2e: authz, tenant-isolation, api contract
│  ├─ worker/                  # NestJS standalone app, BullMQ processors
│  │  └─ src/processors/       # discovery, inventory, update, rolling-update,
│  │                           # major-upgrade, rotation, migration, scheduler
│  └─ web/                     # Next.js App Router frontend + BFF proxy
│     ├─ app/(auth)/           # login, sso callback, setup wizard
│     ├─ app/(dashboard)/      # sidebar shell + all authenticated routes
│     ├─ components/           # ui/ (shadcn), data-table/, status/, forms/
│     └─ lib/                  # api client, session, permission helpers
├─ packages/
│  ├─ db/                      # Prisma schema, migrations, seed, tenancy extension
│  ├─ shared/                  # zod contracts, DTOs, permission catalogue, enums, errors
│  ├─ crypto/                  # envelope encryption, secret store interface + DB backend
│  ├─ proxmox/                 # Proxmox VE API client, ticket/token auth, TLS pinning
│  ├─ remote-exec/             # SSH (ssh2) + WinRM executors, CommandSpec registry
│  ├─ automation/              # playbook engine, step registry, guards, remediations
│  ├─ providers-virt/          # migration source adapters: vmware, hyperv
│  └─ config/                  # env schema + typed config loader (zod), shared by all apps
├─ deploy/
│  ├─ compose/                 # docker-compose.yml, .prod.yml, .dev.yml
│  ├─ caddy/                   # Caddyfile templates
│  └─ systemd/                 # velnox.service unit for appliance installs
├─ scripts/
│  ├─ build.sh  build-tar.sh  build-iso.sh  build-dev.sh
│  └─ lib/                     # shared shell functions (logging, preflight, docker install)
├─ iso/                        # live-build config: hooks, preseed, package lists
├─ docs/                       # this directory
├─ install.sh
├─ uninstall.sh
├─ .env.example
└─ turbo.json  pnpm-workspace.yaml  package.json
```

**Rule:** `apps/*` contain wiring and transport. All reusable domain logic lives in `packages/*` so
api, worker and tests import the same code. No file over roughly 400 lines; a playbook, a
remediation and an adapter each get their own file.

---

## 4. Request lifecycle and the authorization layers

Every authenticated request builds a `RequestContext` held in `AsyncLocalStorage`:

```ts
interface RequestContext {
  userId: string;
  sessionId: string;
  isMspRoot: boolean;            // member of the MSP root tenant
  homeTenantId: string;
  grants: Grant[];               // { permission, scopeType, scopeId }
  accessibleTenantIds: string[]; // pre-resolved; '*' semantics for MSP root
  ip: string; userAgent: string;
}
```

**Layer 1 — explicit authorization.** A `@RequirePermission('nodes.manage')` decorator plus a
*scope resolver* that maps the request to a concrete scope (node → cluster → site → tenant) and
asks the `AuthorizationService` whether any grant covers that permission at or above that scope.
Denials are audited.

**Layer 2 — mandatory query scoping.** A Prisma client extension intercepts every query against a
tenant-scoped model and injects `tenantId IN (...)`. It throws at runtime if a tenant-scoped model
is queried with no `RequestContext` present, unless the caller opted in via an explicit, grep-able
`withSystemScope()` wrapper (used only by workers, migrations and the setup wizard). This means
*forgetting* an authorization check leaks nothing; you must actively bypass it.

**Raw SQL is banned** in application code by an ESLint rule (`no-restricted-properties` on
`$queryRaw`/`$executeRaw`) with a documented allowlist, because raw SQL bypasses layer 2.

**Layer 3 (planned, Phase 15 hardening):** PostgreSQL Row-Level Security on the highest-risk tables
(`credentials`, `nodes`, `vms`, `audit_events`, `jobs`) driven by `SET LOCAL velnox.tenant_ids`
inside an interactive transaction. Deferred because it forces every query into an explicit
transaction and complicates connection pooling; recorded as a known gap rather than silently
skipped.

---

## 5. Authentication design

| Concern | Decision |
|---|---|
| Password hashing | Argon2id, m=64 MiB, t=3, p=4, 32-byte output, per-user random salt |
| Session transport | `HttpOnly; Secure; SameSite=Lax` cookie, same-origin via the BFF |
| Access token | JWT (HS256, `JWT_SECRET`), TTL 15 min, carries `sub`, `sid`, `ver` |
| Refresh token | Opaque 256-bit random, stored **hashed** (SHA-256) in `sessions`, TTL 8 h sliding, rotated on every use, **reuse detection** revokes the whole session family |
| Revocation | `sessions.revoked_at` plus a `ver` counter on the user; a JWT with a stale `ver` is rejected |
| CSRF | Double-submit token in a non-`HttpOnly` cookie plus `X-Velnox-CSRF` header, required on all non-GET requests |
| Brute force | Per-account and per-IP rate limits with exponential backoff; lockout is *soft* (delay) to avoid a trivial account-DoS |
| SSO | Microsoft Entra ID, OIDC authorization code + PKCE; `state`/`nonce` in Redis with a 10-min TTL |
| Break-glass | Local admin login can never be disabled by SSO configuration; disabling local login entirely requires at least one other MSP Super Administrator with a verified local password |
| Machine access | Scoped API tokens (`velnox_pat_<id>_<secret>`), hashed at rest, own permission set, own audit actor type |

**Setup wizard:** the API exposes `GET /api/v1/setup/status`. While `system_settings.initialized`
is false, exactly one mutating endpoint is open — `POST /api/v1/setup/initialize` — which creates
the MSP root tenant, the system roles, the first Super Administrator and flips `initialized`
inside a single database transaction. Afterwards it returns `409 Conflict` permanently. There is
no default account and no default password at any point.

---

## 6. RBAC model

Permissions are strings (`resource.action`) defined once in `packages/shared/permissions.ts` as a
frozen catalogue — the single source of truth for API guards, seed data and the UI.

Roles are **named permission bundles**. System roles (MSP Super Administrator, MSP Administrator,
MSP Engineer, MSP Read Only, Tenant Administrator, Tenant Operator, Tenant Read Only) are seeded
and immutable; custom roles can be created per tenant from the same catalogue.

Authorization is evaluated on a **grant** = (role, scope):

```
RoleAssignment: user × role × scope
scope ∈ { GLOBAL, TENANT:<id>, SITE:<id>, CLUSTER:<id> }
```

`GLOBAL` is assignable only to members of the MSP root tenant and only by a Super Administrator.
A grant at `TENANT:A` implies authority over every site, cluster, node and VM under tenant A. A
grant at `CLUSTER:X` authorises only that cluster's nodes and workloads — this is what makes
"MSP engineer who may only touch customer B's DR cluster" expressible.

Resolution is: *does the user hold any grant containing permission P whose scope is an ancestor of
(or equal to) the target's scope?* The scope ancestry of every resource is materialised on the row
(`tenant_id`, `site_id`, `cluster_id`), so this is a cheap check, not a recursive walk.

---

## 7. Secrets and credential handling

```
MASTER_ENCRYPTION_KEY (32 bytes, base64, from env or secret file)
        │  HKDF-SHA256, info="velnox/kek/v1"
        ▼
      KEK  ──AES-256-GCM──►  wrapped DEK   (per credential, random 32 bytes)
                                  │
                                  ▼
                       AES-256-GCM(secret material)
                       stored: ciphertext ‖ iv ‖ authTag ‖ key_version
```

Envelope encryption (rather than direct encryption) is chosen so that rotating the master key
rewraps DEKs only — it never needs to decrypt and re-encrypt secret payloads — and it gives a
clean seam for a future KMS that wraps DEKs remotely.

`SecretStore` is an interface — `put`, `get`, `delete`, `rewrap` — with `DatabaseSecretStore` as
the v1 implementation and `VaultSecretStore` / `AzureKeyVaultSecretStore` as documented future
backends. **Only the worker ever calls `get()`.** The API can create and reference credentials but
has no code path that returns plaintext material.

### Redaction

- A pino redaction serializer strips known secret-bearing keys, and a final sweep masks anything
  matching stored secret values before a log line or job event is persisted.
- Secrets are never passed as process arguments (visible in `ps`). Password changes are performed
  by writing `root:<password>\n` to the **stdin of a remote `chpasswd`** over the SSH channel.
- `JobEvent` payloads are typed; a step returns structured data, never raw command output that
  might echo a secret. Raw output is captured to a size-capped, redacted `JobLog` blob.

### Rotation ordering (crash-safe)

1. Generate the new password in memory.
2. Persist it encrypted with status `PENDING` — **before** applying it. A crash after step 3 must
   never leave a node with a password Velnox does not know.
3. Apply via `chpasswd` over SSH.
4. Open a *new* connection and authenticate with the new password.
5. On success: mark the new secret `ACTIVE`, the old one `SUPERSEDED` (retained for a configurable
   grace period). On failure: keep both, mark the credential `NEEDS_ATTENTION`, raise an alert,
   delete nothing.

---

## 8. Proxmox integration

`packages/proxmox` wraps the PVE API (`https://<host>:8006/api2/json`).

- **Auth:** API token (`Authorization: PVEAPIToken=user@realm!tokenid=uuid`) preferred; ticket auth
  (`POST /access/ticket` → cookie + `CSRFPreventionToken`) supported where a token cannot be used.
  Tickets are cached in Redis until 10 minutes before expiry.
- **TLS:** Proxmox ships self-signed certificates. Velnox never uses a blanket
  `rejectUnauthorized: false`. When adding an endpoint the certificate fingerprint is shown and
  must be confirmed (trust-on-first-use); the SHA-256 fingerprint is pinned on the row and verified
  on every subsequent connection. A fingerprint change fails the connection and raises an alert. A
  custom CA bundle may be supplied instead.
- **Read path:** `/cluster/status`, `/cluster/resources`, `/nodes`, `/nodes/{n}/status`,
  `/nodes/{n}/version`, `/nodes/{n}/apt/update`, `/nodes/{n}/apt/repositories`,
  `/nodes/{n}/subscription`, `/nodes/{n}/network`, `/storage`, `/cluster/ceph/status`.
- **Task path:** PVE returns a UPID for long operations; the client polls
  `/nodes/{n}/tasks/{upid}/status` and streams `/log` into the Velnox job event stream.
- **Rate/concurrency:** per-endpoint concurrency limiter, retry with jitter on 5xx and PVE
  595/596 responses.

`packages/remote-exec` covers what the API cannot do (`apt dist-upgrade`, `pve8to9`, `chpasswd`,
repository file edits):

- SSH via `ssh2`, key-based where possible, password from the secret store otherwise.
- **Host key verification** is mandatory: TOFU on first connect with explicit operator
  confirmation, pinned thereafter; a mismatch is a hard failure plus an alert.
- Commands are **`CommandSpec` objects from a registry**, not strings from HTTP. A spec declares
  its argv template, whether it is read-only, its timeout, its parser and its required permission.
  No endpoint anywhere accepts a command to run.

---

## 9. Job system and the playbook engine

```
POST /api/v1/…/jobs ──► Job row (QUEUED) ──► BullMQ enqueue
                                                   │
                                             worker picks up
                                                   │
                            ┌──────────────────────┴───────────────────┐
                            │  PlaybookRunner                          │
                            │   for phase in playbook.phases:          │
                            │     for step in phase.steps:             │
                            │       evaluate guards ──► maybe HALT     │
                            │       check cancellation flag            │
                            │       execute (idempotent)               │
                            │       emit JobEvent ──► Redis pub/sub ───┼──► SSE ──► UI
                            │       persist JobStep result             │
                            └──────────────────────────────────────────┘
```

**Job states:** `queued → preflight → waiting_approval → running → validating →
{succeeded | partially_succeeded | failed | rolled_back | cancelled}`. Transitions are enforced by
a state machine; an invalid transition throws.

**Playbooks are data.** A playbook is a versioned object listing phases and step references; steps
come from a `StepRegistry` of small, typed, idempotent implementations. The PVE 8 → 9 upgrade is
one playbook; a future PVE 9 → 10 or a PBS upgrade is another playbook reusing the same steps. No
workflow logic is hardcoded in a single large function.

**Guards** are declarative preconditions evaluated between steps — cluster quorum, Ceph health,
node capacity, workload migratability, concurrency budget. A guard returns `PASS | WARN | BLOCK`;
`BLOCK` halts the run (or the branch) and records exactly which guard fired.

**Rolling updates** are a fan-out playbook with a cluster-level concurrency budget. The safety
invariant is enforced centrally, not per-step: *at no point may the number of simultaneously
unavailable quorum-voting nodes exceed `⌊(n-1)/2⌋`*; default concurrency is 1; and the run refuses
to start if the cluster is already degraded.

**Cancellation** sets a Redis flag; the runner checks it at every step boundary and inside
long-poll loops via an `AbortSignal`. A step in flight is allowed to finish or roll back — Velnox
never kills a `dist-upgrade` mid-transaction.

**Approval gates** are steps that persist an `Approval` row and park the job in
`waiting_approval`. Resuming requires the relevant permission and, when four-eyes is enabled in
policy, a *different* principal from the one who submitted the job.

---

## 10. Major upgrade and remediation framework

Seven phases, as specified: Discovery → Preflight → Remediation Plan → Re-check → Upgrade →
Post-upgrade validation → Report.

`pve8to9` output is parsed into structured `UpgradeCheck` rows:

| Proxmox output | Velnox severity |
|---|---|
| `PASS` | `PASS` |
| `INFO` / `SKIP` | `INFO` |
| `WARN` | `WARNING` |
| `FAIL` | `BLOCKER` |
| unrecognised line | `UNKNOWN` → **treated as a blocker requiring human review** |

Failing safe on `UNKNOWN` is deliberate: Proxmox changes this tool between point releases, and a
parser that silently drops a line it does not recognise would let a real blocker through. The
parser is versioned and the raw output is always retained alongside the parse.

**Remediation plugins** implement:

```ts
interface Remediation {
  id: string; name: string; description: string;
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
  automaticSafe: boolean;        // may run without a human
  requiresApproval: boolean;
  matches(check: UpgradeCheck, ctx: NodeContext): boolean;
  preconditions(ctx): Promise<GuardResult>;
  plan(ctx): Promise<ChangeSet>;   // exact diff, shown to the operator before anything runs
  apply(ctx): Promise<void>;       // idempotent
  validate(ctx): Promise<GuardResult>;
  rollback(ctx): Promise<void>;
}
```

`automaticSafe` is granted only when the change is idempotent, a pre-change backup of the touched
files exists, and `validate()` can positively confirm the result. Everything else — anything
touching storage, networking or non-Proxmox packages — halts for approval and shows the operator
the exact `ChangeSet`. Every remediation writes an audit event containing the before/after diff.

---

## 11. Migration framework

One framework, two source adapters:

```ts
interface MigrationSourceAdapter {
  kind: 'vmware' | 'hyperv';
  testConnection(): Promise<ConnectionResult>;
  discoverHosts(): Promise<SourceHost[]>;
  discoverWorkloads(): Promise<SourceWorkload[]>;   // cpu, ram, disks, nics, firmware, power
  assessCompatibility(w: SourceWorkload, target: TargetSpec): CompatibilityReport;
  buildPlan(w: SourceWorkload, target: TargetSpec): MigrationPlan;
}
```

- **VMware:** vCenter REST (`/api/vcenter/…`) where a vCenter exists; standalone ESXi via its host
  API. For the actual disk transfer, Velnox orchestrates **Proxmox VE's native ESXi import storage**
  (PVE ≥ 8.2) rather than reimplementing transfer — the supported, honest path. Clusters below 8.2
  get discovery, a plan and a documented manual procedure, not a fake button.
- **Hyper-V:** no REST API exists. Discovery runs read-only PowerShell (`Get-VM`, `Get-VHD`,
  `Get-VMNetworkAdapter`) over WinRM. Disk conversion is `qemu-img convert` from VHDX, which
  requires the VHDX to be reachable by a Velnox-controlled transfer step (SMB or SSH). In v1 that
  transfer step is operator-assisted and clearly labelled as such in the UI.

`assessCompatibility` is a first-class output, not an afterthought: UEFI/Secure Boot, vTPM,
independent/RDM disks, existing snapshots, PVSCSI/VMXNET3 drivers, VM generation, dynamic memory
and cluster-shared storage all produce explicit warnings. The wizard never implies a lossless 1:1
conversion.

---

## 12. Frontend architecture

Next.js App Router, TypeScript, Tailwind, shadcn/ui (Radix primitives), TanStack Query and Table,
`next-themes` for dark mode. Server Components for the shell and initial data; Client Components
for tables, drawers and live job streams.

- The browser never sees a bearer token. Route handlers under `app/api/[...proxy]` forward cookies
  to the api container over the internal network.
- Permissions are fetched once per session into a context; the UI *hides* what a user cannot do,
  but this is cosmetic — the server is the authority and returns 403 regardless.
- Live job progress is an `EventSource` against `/api/v1/jobs/:id/stream`, with automatic reconnect
  and a polling fallback.
- Visual language: dense tables, muted neutral surfaces, semantic status colours only
  (ok / warn / error / unknown), no gradients, no glassmorphism, no marketing animation. Layout and
  navigation exactly as specified in the brief.

---

## 13. Deployment

Six Compose services: `caddy`, `web`, `api`, `worker`, `postgres`, `redis`. `api` and `worker` are
the **same image** with different entrypoints — one build, two roles.

- Health checks on every service; `depends_on: condition: service_healthy`.
- `postgres` and `redis` sit on an internal network with **no published ports**.
- Named volumes `velnox_pgdata`, `velnox_redisdata`, `velnox_caddydata`.
- Migrations run in a one-shot `migrate` service that must exit 0 before `api` starts — never on
  api boot, which would race across replicas.
- Secrets are generated by `install.sh` into `.env` (mode 0600) and, where supported, mounted as
  Docker secrets files with `*_FILE` env indirection.
- `install.sh` is idempotent: it preserves an existing `.env`, installs Docker only when missing,
  and re-runs migrations safely.

---

## 14. Observability and operations

- Structured JSON logging (pino) with request-id correlation and mandatory redaction.
- `/healthz` (liveness) and `/readyz` (DB and Redis reachable, migrations current).
- Optional `/metrics` in Prometheus format: queue depth, job durations, API latency, adapter error
  rates. Disabled by default, enabled by env.
- Backup: a documented `pg_dump` plus `.env` procedure. **Losing `MASTER_ENCRYPTION_KEY` makes
  every stored credential unrecoverable** — stated loudly in the installer output, the README and
  the backup docs.

---

*Velnox™ and the Velnox logo are trademarks of The Velnox Foundation.*

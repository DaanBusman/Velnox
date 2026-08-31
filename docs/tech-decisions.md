# Velnox — Technology Decisions (ADR log)

**Status:** Phase 0. These decisions are proposals awaiting approval; nothing is implemented yet.
Each entry states the decision, the alternatives considered, and why the alternative lost.

---

## ADR-001 — Monorepo with pnpm workspaces + Turborepo

**Decision:** Single repository, `pnpm` workspaces, Turborepo for task orchestration and caching.

**Alternatives:** npm/yarn workspaces (slower installs, no strict node_modules isolation); Nx
(more powerful, heavier conceptual overhead than this project needs); polyrepo (rejected — the API
and worker must share domain code and the Prisma client, and version skew between them would be a
correctness bug, not an inconvenience).

**Consequence:** api, worker, web and all packages share one TypeScript config base, one ESLint
config, one lockfile, and one `pnpm build` that is incrementally cached.

---

## ADR-002 — NestJS for the backend

**Decision:** NestJS 11 on Node 22 LTS.

**Why:** The requirement list is essentially a list of NestJS strengths — guards for RBAC,
interceptors for audit and redaction, modules for service boundaries, DI for the adapter registries,
first-class BullMQ and OpenAPI integration, and a testing story that makes RBAC and tenant-isolation
tests straightforward.

**Alternatives:** Fastify + hand-rolled structure (faster to start, but we would rebuild DI, guards
and module boundaries ourselves); Express (too little structure for a project this size);
Go/Rust (better raw performance, but this workload is I/O-bound orchestration, and TypeScript
end-to-end lets the frontend import the same zod contracts).

---

## ADR-003 — Next.js App Router for the frontend, used as a BFF

**Decision:** Next.js 15, App Router, TypeScript, Tailwind, shadcn/ui.

**Why BFF:** The browser holds no token. Session cookies stay `HttpOnly` and same-origin; Next
route handlers proxy `/api/v1/*` to the api container over the internal Docker network. This
removes CORS entirely, removes token-in-JS XSS exposure, and keeps the API surface private.

**Alternatives:** Vite SPA + direct API calls (needs CORS, needs a token reachable by JS, or
cookie handling across origins); Remix (fine, smaller ecosystem for the component library we want).

---

## ADR-004 — PostgreSQL 16 + Prisma

**Decision:** PostgreSQL 16 as the only persistent store; Prisma as ORM and migration tool.

**Why Prisma:** Typed client shared by api and worker; a mature migration workflow
(`prisma migrate deploy` in a one-shot container); and, decisively, **client extensions**, which
give us a single place to enforce tenant scoping on every query.

**Trade-off accepted:** Prisma's raw-SQL escape hatch bypasses that extension. Mitigated by an
ESLint ban on `$queryRaw`/`$executeRaw` outside an allowlist, and by tenant-isolation tests.

**Alternatives:** Drizzle (lighter, better raw SQL story, but no equivalent global query
interception); TypeORM (weaker types, migration ergonomics we do not want on a security boundary).

---

## ADR-005 — Redis + BullMQ for the queue, PostgreSQL for job truth

**Decision:** BullMQ on Redis 7 for scheduling and execution; a `jobs` table in PostgreSQL as the
system of record for state, steps, events and approvals.

**Why both:** Redis gives us retries, delayed jobs, repeatable (cron) jobs, concurrency limits and
pub/sub for live progress. But job history, approval decisions and audit trails are compliance
artifacts and must survive a Redis flush. On worker start a reconciler compares the two and
re-enqueues or fails-forward orphans.

**Alternatives:** PostgreSQL-only queue (pg-boss / SKIP LOCKED) — one fewer service, but weaker
scheduling primitives and no pub/sub for SSE; Temporal (excellent fit for the workflow semantics,
but adds a whole cluster to a self-hosted appliance — rejected on operational weight).

---

## ADR-006 — SSE over WebSockets for live job progress

**Decision:** Server-Sent Events on `GET /api/v1/jobs/:id/stream`, fed by Redis pub/sub.

**Why:** Progress is strictly server → client. SSE reuses the existing cookie auth and HTTP
middleware stack (including the RBAC guard), survives reverse proxies without an upgrade dance,
and reconnects natively. WebSockets would require a parallel auth path — exactly the kind of
second door that produces authorization gaps.

---

## ADR-007 — Argon2id, JWT access token, opaque rotating refresh token

**Decision:** As described in [architecture.md](architecture.md#5-authentication-design).

**Why not long-lived JWTs alone:** They cannot be revoked. For a tool that holds hypervisor root
credentials, immediate session revocation is mandatory. Short access tokens plus a server-side
refresh record give revocation without a DB read on every request.

**Why not pure server-side sessions:** Also acceptable; the hybrid keeps the hot path stateless
while retaining revocation. `JWT_SECRET` is already part of the required configuration surface.

---

## ADR-008 — Envelope encryption with a pluggable SecretStore

**Decision:** AES-256-GCM DEK per secret, wrapped by a KEK derived from `MASTER_ENCRYPTION_KEY`
via HKDF-SHA256, behind a `SecretStore` interface.

**Why:** Master-key rotation rewraps DEKs only. A future Vault or Azure Key Vault backend replaces
the wrapping step without touching a single call site. Storing secrets encrypted with the master
key directly would make rotation a full re-encryption of every row and would hardcode the trust
model.

---

## ADR-009 — The API container performs no outbound automation

**Decision:** Proxmox, SSH and WinRM adapters are loaded only in the worker image role. The API can
enqueue work; it cannot execute it.

**Why:** It converts a whole class of vulnerabilities (SSRF, command injection through a request
parameter, an authorization bug turning into remote root) into a missing-code-path error. It also
means a compromised API process cannot decrypt credentials for use.

**Cost:** Some read operations that would be trivially synchronous become jobs. Accepted; a cached
inventory read path serves the UI, and a "refresh now" action enqueues a discovery job.

---

## ADR-010 — Commands are registry entries, never strings from HTTP

**Decision:** A `CommandSpec` registry defines every remote command: argv template, typed
parameters, read-only flag, timeout, output parser, required permission.

**Why:** There is no endpoint that accepts a command. Parameters are typed and escaped by the spec,
not concatenated. Auditing shows *which spec* ran with *which typed parameters*, which is far more
useful than a shell string.

---

## ADR-011 — Playbooks are data, not code paths

**Decision:** Upgrade, update and migration workflows are versioned playbook definitions composed
of registered steps and guards.

**Why:** The brief explicitly requires the major-upgrade engine to be generic (PVE 9 → next, PBS,
Ceph). A data-driven engine also makes the workflow *inspectable* — the UI can render the plan
before execution, and tests can assert on the plan rather than on side effects.

---

## ADR-012 — Caddy as reverse proxy

**Decision:** Caddy 2, with a generated self-signed certificate by default and optional ACME when
a public hostname is configured.

**Why:** Smallest configuration surface, automatic HTTPS, sane security headers, single binary.
Traefik's dynamic discovery buys nothing in a fixed six-service appliance; nginx would need us to
hand-write TLS and header configuration.

---

## ADR-013 — One backend image, two roles

**Decision:** `velnox/backend` is built once; the `api` and `worker` services differ only by
entrypoint and by which modules bootstrap.

**Why:** Halves build time and image storage in the tar.gz artifact, and guarantees api and worker
run identical domain code.

---

## ADR-014 — Debian ISO via live-build in a container

**Decision:** `scripts/build-iso.sh` runs Debian `live-build` inside a Debian container to produce
an installer ISO that ships the Velnox bundle and runs `install.sh` on first boot.

**Known constraint, documented rather than hidden:** live-build needs loop devices and elevated
privileges; the build container therefore requires `--privileged` (or specific device access) on a
Linux host. ISO building is **not supported on Docker Desktop for Windows/macOS**. If that
constraint cannot be met, `build.sh --target iso` fails with a clear message — it never emits a
non-bootable placeholder file.

**Alternatives:** Packer + debian-installer preseed (viable, adds a second toolchain); building a
cloud image instead of an ISO (planned as an additional target, not a replacement).

---

## ADR-015 — Testing stack

**Decision:** Vitest for unit tests; Jest-free. Supertest against a real NestJS app instance for
API tests; Testcontainers (PostgreSQL + Redis) for integration tests; Playwright for a small
smoke suite covering setup wizard, login and a job run.

**Mandatory suites (CI-blocking):** tenant isolation (cross-tenant read *and* write, for every
tenant-scoped resource), RBAC permission matrix, secret redaction, and the rolling-update quorum
invariant.

---

## Version targets

| Component | Version |
|---|---|
| Node.js | 22 LTS |
| pnpm | 9.x |
| NestJS | 11.x |
| Next.js | 15.x |
| PostgreSQL | 16 |
| Redis | 7.x |
| Prisma | 6.x |
| Caddy | 2.x |
| Debian base image | bookworm-slim |
| Proxmox VE support | 8.x and 9.x (upgrade path 8 → 9) |

---

*Velnox™ is a trademark of The Velnox Foundation.*

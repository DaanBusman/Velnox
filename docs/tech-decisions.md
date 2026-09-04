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

**Why BFF:** The browser holds no token. Session cookies stay `HttpOnly` and same-origin, and
pages read the API from Server Components over the internal Docker network.

**Amended in Phase 1 — no proxy route.** The original plan added Next route handlers proxying
`/api/v1/*`. Caddy already serves the API on the same origin, which is what removes CORS and lets
the `HttpOnly` cookie work; and because machine clients need API tokens against a reachable API,
keeping the API off the public origin was never actually achievable. The proxy would have been an
extra hop and a second code path with no security gain, so it was dropped. `lib/api.ts` is marked
`server-only`, which turns an accidental import from a Client Component into a build error.

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

## ADR-016 — Ceph upgrades are a separate playbook, composed into the plan

**Decision:** Ceph major-version upgrades are in v1 scope, implemented as their own playbook on the
generic engine. An upgrade plan for a Ceph-backed cluster is a **composite**: the Ceph playbook runs
to completion first, then the PVE major-upgrade playbook.

**Why not a phase inside the PVE upgrade:** the two workflows have different units of work (Ceph
restarts *daemons*, PVE upgrades *nodes*), different health models (Ceph `HEALTH_OK` and PG state
vs. corosync quorum) and different failure modes. Fusing them would produce exactly the large
monolithic function the brief forbids, and would make "upgrade Ceph only" — a common standalone
maintenance task — impossible to express.

**Why Ceph first:** a PVE major release ships a specific Ceph release and does not support the
previous one, so the Ceph upgrade must complete while the cluster is still on its current PVE and
Debian release.

**Version pairing is data, and verified:** source → target release pairs live in a version-matrix
data file, and the matrix is checked against the live cluster at plan time. Disagreement between
the running release, the target and the matrix refuses the plan rather than guessing — the same
fail-safe posture as the `pve8to9` parser.

**Consequence:** genericity of the Phase 8 engine is proven by construction, since two very
different workflows run on it unchanged.

---

## ADR-017 — MFA: TOTP, optional but recommended; WebAuthn deferred

**Decision:** TOTP (RFC 6238) plus Argon2id-hashed single-use recovery codes. Default policy
`OPTIONAL`, with `REQUIRED_FOR_PRIVILEGED` and `REQUIRED` available per installation and per tenant.
The UI recommends enrolment during setup and flags privileged accounts without it.

**Why TOTP first:** it needs no hardware, works for every operator, and — decisively — it works for
the **break-glass account**, which must remain usable when SSO and the network to the identity
provider are unavailable. WebAuthn's platform-authenticator model is a poor fit for an account whose
whole purpose is being usable from an unexpected machine during an incident.

**Why not required by default:** the first administrator is created by the setup wizard before any
authenticator is enrolled, and forcing enrolment there risks locking out an operator who has not yet
stored recovery codes. `REQUIRED_FOR_PRIVILEGED` is a one-click policy change once the installation
is running, and this is what the documentation recommends.

**Storage:** the TOTP seed is secret material and goes through the `SecretStore`, not into a plain
column. Recovery codes are hashed, never retrievable, and shown exactly once.

**Deferred:** WebAuthn/passkeys as a second factor type — the `user_mfa_factors.kind` discriminator
exists for it.

---

## ADR-018 — The tar.gz artifact bundles images for air-gapped installation

**Decision:** `build.sh --target tar` includes `docker save`d images by default; a `--slim` variant
pulls from a registry.

**Why:** Velnox is installed inside customer networks and management VLANs where outbound access to
a container registry is frequently the thing that blocks an installation. ~1 GB of artifact is a
cheap price for "it installs on the first attempt, offline".

**Honest limit:** Docker itself is still installed from Debian/Docker repositories when absent. A
genuinely offline host must already have Docker. The installer detects this case and says so up
front rather than failing halfway through.

---

## ADR-019 — Localization: keys everywhere, ICU catalogues, error codes over sentences

**Decision:** English and Dutch in v1. No user-visible string in application source; every one is a
key against an ICU MessageFormat catalogue. The API returns machine-readable error codes with typed
parameters, and the frontend renders them. A `glossary.csv` controlled vocabulary is the source of
truth for both UI catalogues and Dutch documentation.

**Why from commit one:** retrofitting externalised strings means touching every component and every
exception in the codebase. It is one of the few decisions that is nearly free at the start and
expensive at any later point.

**Why error codes:** they make a new language cover API errors for free, and they are stable enough
to assert on in tests, alert on, and document — a side benefit worth as much as the translation.

**Deliberately untranslated:** audit events, job events and logs. They are forensic records, they
embed verbatim Proxmox/`apt`/Ceph output, and a support engineer must never have to guess which
language a customer's audit trail was written in.

**Cost acknowledged:** two documentation sets double maintenance across fifteen phases. Mitigated by
recording the source commit in each Dutch file and a CI check that *warns* on drift — English
documentation is never blocked by a pending translation. See [i18n.md](i18n.md).

---

## ADR-020 — AGPLv3

**Decision:** GNU Affero General Public License v3.0 (canonical text in `LICENSE`, retrieved
verbatim from gnu.org).

**Why AGPL over GPL:** Velnox is network-accessed management software — precisely the category where
the GPL's distribution trigger never fires, because a hosted operator never "distributes" anything.
Section 13 closes that gap.

**Why copyleft at all rather than Apache-2.0/MIT:** the project's value is the accumulated safety
logic — quorum invariants, preflight parsing, remediation definitions. A permissive licence invites
that to be absorbed into closed products without the corrections flowing back, and incorrect safety
logic in this domain damages third-party production infrastructure.

**Consequences that are engineering work, not paperwork:**
- §13 compliance is a product feature: `GET /api/v1/system/source` and a Settings → About link, both
  driven by a build-time `VELNOX_SOURCE_URL` and the embedded git commit.
- `THIRD-PARTY-NOTICES.md` is generated from the lockfile at build time and ships in every artifact.
- Dependency licences must be AGPL-compatible; a CI licence check rejects incompatible additions.
  This rules out some commercially-licensed component libraries — a real constraint on the frontend,
  and one reason shadcn/ui (MIT, vendored source) was chosen over a licensed enterprise grid.
- Trademarks are handled separately, because the AGPL grants none: see `TRADEMARK.md`.

---

## ADR-021 — zod for request validation, not class-validator

**Decision:** a `ZodValidationPipe` validates request input against the same zod schemas that define
the API contracts. `class-validator` and `class-transformer` are not used.

**Why:** the architecture already puts zod contracts in `packages/shared`. Adding a second,
decorator-based validation system means two definitions of the same shape that can disagree — and
when they disagree, the one that runs is not the one anyone read. One source of truth is worth the
cost.

**Cost, stated plainly:** `@nestjs/swagger` derives schemas from class decorators, so response and
body schemas are written explicitly in `@ApiResponse` rather than inferred. For Phase 1 that is a
handful of endpoints. If it becomes a burden, a zod-to-OpenAPI generator closes the gap without
changing the validation story.

---

## ADR-022 — `consistent-type-imports` is disabled in the NestJS apps

**Decision:** the lint rule is on everywhere except `apps/api` and `apps/worker`.

**Why:** NestJS resolves constructor dependencies from the runtime type metadata that
`emitDecoratorMetadata` emits. `import type { PrismaService }` erases the class, the metadata
becomes `undefined`, and injection fails at runtime with an error that points at the module rather
than at the import. The rule's autofix introduces exactly that bug — it did, during Phase 1, before
this override existed. A lint rule that can silently break dependency injection does not belong in
a codebase that uses it.

---

## ADR-023 — The API may decrypt its own authentication material, and nothing else

**Amends ADR-009 (Phase 2).**

**Decision:** The API's secret store refuses to decrypt any credential whose kind is not
`TOTP_SEED` or `OIDC_CLIENT_SECRET`. Those two are the material Velnox uses to authenticate its own
users. Every credential belonging to managed infrastructure — Proxmox passwords, SSH keys, WinRM
credentials — remains readable only by the worker. The restriction is enforced by kind in
`SecretStoreService`, throws `ForbiddenCredentialKindError`, and has no flag to turn it off.

**Why:** ADR-009 says a compromised API process cannot decrypt credentials for use. Verifying a TOTP
code needs the seed, in the API, on the sign-in path. Routing every sign-in through the job queue to
borrow the worker's key would add a queue round trip to the latency of logging in, and would put the
second factor behind the very system an operator uses the second factor to reach.

The alternative — quietly letting the API read everything and treating ADR-009 as aspirational — is
how a boundary becomes a comment. So the boundary moved to where it can actually be held, and became
enforceable rather than declarative. The sentence that matters is unchanged: a compromised API
process still cannot decrypt a single customer credential.

**Cost:** The API holds the master key and can derive the KEK, so the restriction is a check in code
rather than an absence of capability. A remote code execution bug in the API could bypass it. What
it does prevent is the far likelier case: an authorization bug, an over-broad query, or a future
endpoint that reads more than its author intended. Separating the keys themselves would need a
second KEK and a key-management story that Phase 2 does not have; it is recorded in
`docs/known-gaps.md` rather than claimed here.

---

## ADR-024 — One version number, bumped on every change, and documentation that ships with it

**Decision:** The `version` field in the root `package.json` is the only place a version is
authored. `scripts/version.mjs` writes it into the nine other manifests, the two compose defaults
and `.env.example`; `pnpm run validate:version` fails the lint task if any of them drift. Every
change that ships bumps it — `bump patch` for a fix, `bump minor` for a feature — and `bump major`
is refused by the script, because reaching 1.0.0 is a decision the product owner makes rather than
an arithmetic step.

The documentation set under `docs/` is converted to HTML at build time and bundled into the web
image, and every page renders **"This Documentation applies to version VX.Y.Z"** (in Dutch,
**"Deze Documentatie is toepasbaar voor versie VX.Y.Z"**). That string comes from the same
`package.json` field the running software reports.

**Why:** Documentation on a management appliance is needed exactly when the network is not
available, so it cannot live only on GitHub. And documentation that does not say which version it
describes is worse than none: an operator following an upgrade procedure from a different release
can do real damage.

Tying both to one field is what makes the sentence true rather than decorative. The documentation
and the software are produced by one build, from one version string, so they cannot be a release
apart — and when they somehow are, because an upgrade replaced one container and not the other, the
documentation page says so instead of quietly describing the wrong software.

**Cost:** Every change now touches the version, which shows up in the diff of eleven files. That is
the point: a change that does not bump the version is visible as such. `install.sh` refreshes
`VELNOX_VERSION` in `.env` on every run for the same reason it refreshes the build commit — it is
build metadata, not configuration, and a pinned stale value would make every documentation page
report a mismatch that is not real. `scripts/verify-stack.sh` asserts against a running stack that
the reported version matches the source.

---

## Version targets

| Component | Version |
|---|---|
| Node.js | 22 LTS |
| pnpm | 10.x (Phase 0 said 9.x; 10 is what the toolchain resolved to) |
| NestJS | 11.x |
| Next.js | 15.x |
| React | 19.x |
| Tailwind CSS | 4.x |
| PostgreSQL | 16 |
| Redis | 7.x |
| Prisma | 6.x |
| Caddy | 2.x |
| Debian base image | bookworm-slim |
| Proxmox VE support | 8.x and 9.x (upgrade path 8 → 9) |
| Ceph support | releases as declared in the version matrix, verified against the live cluster at plan time |
| Localization | `en` (source), `nl`; ICU MessageFormat via next-intl |
| Licence | AGPL-3.0-or-later |

---

*Velnox™ is a trademark of The Velnox Foundation. Velnox is free software under the AGPLv3.*

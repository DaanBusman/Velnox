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

**Decision:** Next.js 16, App Router, TypeScript, Tailwind, shadcn/ui.

**Why BFF:** The browser holds no token. Session cookies stay `HttpOnly` and same-origin, and
pages read the API from Server Components over the internal Docker network.

**Amended in Phase 1 — no proxy route.** The original plan added Next route handlers proxying
`/api/v1/*`. Caddy already serves the API on the same origin, which is what removes CORS and lets
the `HttpOnly` cookie work; and because machine clients need API tokens against a reachable API,
keeping the API off the public origin was never actually achievable. The proxy would have been an
extra hop and a second code path with no security gain, so it was dropped. `lib/api.ts` is marked
`server-only`, which turns an accidental import from a Client Component into a build error.

**Amended in Phase 5 — Next.js 15.5 → 16.3.** A major version, and less changed than that suggests,
because the code had already moved where 16 insists: every `params` and `searchParams` was awaited,
there is no middleware to rename to `proxy`, and nothing used the caching or image APIs that changed.
What did change:

- **next-intl had to move from 3 to 4.** 3.x declares Next 15 as its ceiling. One type error came
  with it: 4 types the key passed to `t()` strictly, and a lookup in a `Record<string, string>` is
  `string | undefined` even after a truthiness check on the same expression. Fixed by reading it into
  a variable first.
- **next-intl 4 brings two packages with install scripts**, `@swc/core` and `@parcel/watcher`, both
  for a message extractor Velnox does not use. Both are denied in `pnpm-workspace.yaml`, with the
  reason beside them — the same reasoning as `msgpackr-extract`.
- **The `eslint` key in `next.config.ts` is gone**, because `next build` no longer lints. The key
  existed only to stop it doing so.
- **`next build` uses Turbopack by default.** No configuration was needed; the build and the
  standalone output worked as they were.

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
and `.env.example`; `pnpm run validate:version` fails the lint task if any of them drift.

**Below 1.0.0 the minor number is the phase number.** Every shipped change bumps the patch;
completing a phase runs `version:phase <n>`, which is the only thing that moves the minor, and which
refuses unless `docs/roadmap.md` marks that phase complete. `validate:version` fails when the two
disagree. `bump minor` and `bump major` are both refused by the script — the first because it would
silently spend a phase number, the second because reaching 1.0.0 is a decision the product owner
makes rather than an arithmetic step.

**Amended:** the original rule was `bump patch` for a fix and `bump minor` for a feature, which is
ordinary semver and was wrong for a product with a numbered plan. It reached 0.8.0 during Phase 2 —
most of the numbering spent on a fifth of the work, with Phase 15 heading somewhere past 0.20.0 and
1.0.0 nowhere in sight. The version was renumbered once, backwards, from 0.8.0 to 0.2.4. That is a
real cost, paid deliberately: an installation upgraded across it sees its version go down, which
looks like a downgrade and is not. Doing it at Phase 2 is as cheap as it will ever be.

The scheme means the version answers "how far along is this", which for a product built to a
published roadmap is the question people actually ask. Phase 9 is split into 9A and 9B; both are
phase 9, so 9B ships as patches on minor 9.

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

## ADR-025 — The founding administrator cannot be locked out of its own installation

**Decision:** The account the setup wizard creates carries `users.is_founding_administrator`. Its
role assignments cannot be revoked by anyone, including itself, and it cannot be disabled while no
other enabled account holds `roles.manage`. A partial unique index allows at most one such account.

**Why:** Because the alternative happened. An administrator could revoke their own last role, and on
an installation with one account — which is every installation on its first day — that removed the
last permission in the system. Signing in still worked. Nothing was allowed. The only way back was a
`psql` prompt, on a product whose entire premise is that operators should not need one.

Disabling stays possible because it is reversible by anyone who still holds permissions, and an
organisation does need a way to stop a departed administrator's account. Removing its permissions is
not reversible from inside the product, which is the whole difference.

`roles.manage` rather than `system.manage` is the test for "is there another way in". Recovery means
granting a role back, and an account that can manage roles but not installation settings can still do
that. The stricter permission would have refused operations that are perfectly safe.

**Cost:** One account in the installation is permanently privileged, which is a real concentration of
trust — its password and second factor matter more than any other. That is stated in the interface
next to the account rather than left to be discovered. The alternative, a product that can be bricked
by one click in its own UI, is worse.

The repair for installations that already hit this ships in the migration itself: it marks the
founding administrator and restores the grant if it is missing. That hands an account permissions it
did not have a moment earlier, which deserves the suspicion it invites — it is enforcing the new
invariant on existing data, not a back door, and it changes nothing where the grant is still present.

---

## ADR-026 — Operator guides are separate from the reference documents, and ship with the feature

**Decision:** The bundled documentation is split in two. **Guides** — `getting-started.md`,
`managing-access.md`, `permissions.md` and their successors — are task-shaped and answer "how do I
do this". **Reference documents** — architecture, the schema, these decisions, the roadmap — answer
"how is this built and why". The guides come first in the reading order. Every phase that adds
something an operator does writes the guide for it in that phase, in both languages, and
`docs/roadmap.md` records which guide each remaining phase owes.

**Why:** The offline documentation was the repository's own engineering documentation, rendered
inside the product. That is genuinely useful to the person maintaining Velnox and close to useless
to the person operating it: someone who wants to add a node does not want an ADR about why the
worker holds the credentials. The two audiences want different documents, and one document cannot
serve both without serving neither.

Shipping the guide in the same phase as the feature is the part that will be tempting to skip.
Documentation written a phase later is written by someone reconstructing what they did, which is how
a guide comes to describe a button that was renamed. Documentation deferred to phase 15 is
documentation that arrives after every decision it could have improved.

**Cost:** Every feature phase is now larger by a guide in two languages, and there is one more thing
that can fall out of step with the code. The second cost is mitigated where it matters most: the
role matrix in `permissions.md` is compared to the permission catalogue by a test, in both
languages, because it is the document an administrator makes access decisions from and a stale
matrix there is a security problem rather than a documentation problem. The prose is not
machine-checked and cannot be — `scripts/check-doc-sync.mjs` reports translation drift, and beyond
that it is review.

The first cost is the point rather than a regret. A phase that cannot spare the time to explain what
it built has not finished building it.

---

## ADR-027 — Server management is a window, not a section, and it is gated on `system.manage`

**Decision:** Everything about the Velnox installation *itself* — its readiness, its audit trail,
the certificate it serves, the build it is running — is one window opened from the bottom of the sidebar, over whatever
the operator was doing, closed with an ✕ or Escape. It is rendered only for `system.manage`, which in
the shipped catalogue is the MSP Super Administrator alone.

**Why a window rather than a section:** these are not destinations. You come to check a certificate
or read an audit trail, and then you go back to the tenant, cluster or account you were actually
working on. A route would have made that a navigation away and back, losing the page state behind it
for something that takes twenty seconds. It is also the honest shape of the grouping: the server is
not another thing in the fleet, it is the thing the fleet is managed *from*.

**Why the grouping at all:** the audit log, the certificate and the version sat among tenant and
fleet administration in one flat list, which put "who signed in" next to "which build is running"
next to "grant this person a role". Those are different jobs, usually done by different people.

**Cost, and what it does not do to the audit log.** Gating the window on `system.manage` would have
taken the audit log away from MSP Read Only and Tenant Administrator, who hold `audit.read` and no
management permission — and the read-only role exists precisely to review what happened. So the
audit log keeps its sidebar entry for whoever holds `audit.read` *without* `system.manage`, and the
window carries the same panel for everyone else. One component rendered in two places; the
alternative was two audit tables drifting apart, and the one that drifts is the one nobody is
looking at.

The `/settings/certificate` route was removed rather than kept alongside the panel. Everyone who
could reach it can open the window, so a second implementation would have been maintained for nobody.

---

## ADR-028 — The interface has an elevation scale

**Decision:** Surfaces are layered rather than flat. There is a four-step shadow scale, a lit top
edge on anything raised, softer radii, and a shallow wash on the application background. Depth is
built differently in the two themes: on light, shadow does the work; on dark, the surface gets
*lighter* as it rises and the highlight carries the edge, with shadow only deepening the separation.

**Why:** the original rule was "flat surfaces, no gradients anywhere", written to keep this from
looking like a marketing page. It succeeded at that and produced something that read as unfinished —
every plane at the same depth, so nothing said what sat on top of what, and a dialog looked like a
region of the page rather than something over it. That is fine while building and wrong to ship.

The identity does not change. Still one accent colour, still semantic colours used only for status,
still no glassmorphism and no decorative gradient. What changed is that a card now looks like an
object and a modal looks like it is in front.

**Cost:** more tokens to keep consistent, and two theme-specific elevation recipes rather than one.
A component that reaches for a raw colour instead of the scale will look subtly wrong in one theme
and pass review in the other — which is the failure mode to watch for, and the reason the recipes
live in `globals.css` as named tokens rather than as utility strings copied between components.

---

## ADR-029 — pnpm 12, and the four things that broke on the way

**Decision:** The workspace runs pnpm 12. `packageManager` in the root
`package.json` is the single pin, honoured by CI through `pnpm/action-setup` and by both images
through corepack.

**Why:** there was never a reason for the previous pin. `pnpm@10.33.4` was written in the Phase 1
bootstrap commit and never revisited, so it was drift rather than a decision. pnpm skipped 11
entirely; 12 is the supported line.

**What it cost.** Four things broke, and none of them is a version number:

1. **The build-script allowlist was renamed and moved.** `pnpm.onlyBuiltDependencies` in
   `package.json` — a list — became `allowBuilds` in `pnpm-workspace.yaml`, a map. pnpm 12 ignores
   the old key. It fails the install rather than warning when a package wants a build script it has
   no ruling on, so the control could not silently lapse — but `pnpm config get onlyBuiltDependencies`
   still echoed the old value back, which looks exactly like the setting working. It reads the
   settings map without validating the key. That is worth remembering the next time one moves.

2. **Two packages had been silently ignored.** pnpm 10 warned about a blocked build script; pnpm 12
   errors. `@scarf/scarf` (install telemetry, via `swagger-ui-dist`) and `msgpackr-extract` (an
   optional native accelerator, via BullMQ) had never been on the allowlist and nobody had noticed.
   Both are now denied explicitly, with the reason next to them.

3. **corepack no longer bakes pnpm into the image.** pnpm 12 ships as a native binary that its shim
   downloads on *first use*, so `corepack prepare --activate` leaves a 5 MB shim and no pnpm. The
   first thing to discover that would have been the migrate container — on the internal network,
   with no route off the host, during an upgrade. Both Dockerfiles now invoke `pnpm --version` in
   the same layer, which pulls the binary into `COREPACK_HOME` where the runtime stage inherits it.
   Verified by building the image and running the migrate command under `--network none`.

4. **An older global pnpm cannot hand off to 12 on Windows.** It downloads the package without
   running the install script that replaces the placeholder with the native binary, and the shim
   then points at a text file. Not fixable from this repository; the README says to install
   `@pnpm/exe` at the pinned version once.

   This one recurs on **every** pin bump, because the download is per version: moving to 12.5.1
   reproduced it exactly, from a machine that already had a working 12.3.4. Worth knowing before
   assuming a patch bump is free on Windows.

**What did not change:** the lockfile diff is purely additive — 101 lines, no deletions, not one
dependency version moved. `lockfileVersion` is still `9.0`; pnpm 12 prepends a second YAML document
recording the package manager itself.

**Amended, 12.3.4 → 12.5.1.** Nothing broke. Lint, typecheck and the full test suite pass, both
images build and carry the new binary, and `--network none` still starts pnpm — the check that
matters for the migrate container on an isolated network. The only thing that recurred is the
Windows handoff above, which recurs on every bump.

The lockfile moved by 94 lines added and 37 removed, and **every one of them is pnpm describing
itself**: the `packageManagerDependencies` specifier, and the per-platform `@pnpm/exe.*` entries.
Not one other package is touched, and `lockfileVersion` is still `9.0`. Six platforms appear that
12.3.4 did not publish — android on both architectures, FreeBSD x64, and Linux on ppc64, riscv64 and
s390x — which is why the diff grows rather than swapping line for line.

Worth recording how that was nearly got wrong: the first two `pnpm install` runs left the lockfile
untouched, because one found node_modules already correct and the other was `--frozen-lockfile`,
which by definition does not write. The rewrite happened later, under an ordinary pnpm invocation.
"I checked and the lockfile did not change" was true when it was said and false by the time it
mattered, which is an argument for checking `git status` at the end of a change rather than in the
middle of one.

**Amended, 12.5.1 → 12.6.0.** Nothing broke. Lint, typecheck and the full test suite pass, both
images build, and `pnpm --version` answers 12.6.0 in both under `--network none`. The lockfile moved
by 62 lines each way and every one is again pnpm describing itself — version numbers and integrity
hashes, the same platforms as 12.5.1. The `pnpm@12.6.0` integrity in the lockfile matches the one the
registry publishes.

Two things are worth recording.

The Windows handoff did **not** recur here — but only through the path that was tested. 12.5.1 was
run through Node (`node …/pnpm.mjs`), saw the new pin, fetched 12.6.0 and handed over to it, and the
native `pnpm.exe` it fetched is the real 51 MB binary rather than a placeholder. Whether a globally
installed native `pnpm.exe` hands over as cleanly could not be tried: on the machine this was done
on, a Device Guard policy blocks `pnpm.exe` from running at all. So the README still says to install
`@pnpm/exe` at the pinned version, and point 4 above stands until someone sees otherwise.

And checking the images found something that had been wrong since the move to pnpm 12, not something
12.6.0 introduced. The bake — `pnpm --version` in `/app`, as root — writes a `pnpm-lock.yaml`
recording the package manager, with mode 600. The backend's build stage copies the real lockfile
over it and never noticed. The web runtime does not, so it carried a stub its own `node` user cannot
read, and any pnpm run in `/app` failed with "Permission denied". Reproduced identically on 12.5.1
with a bare image before changing anything. Nothing in the web container runs pnpm, so no
installation was affected.

The first fix was wrong, and the check caught it. Deleting the stub made pnpm in `/app` go to the
registry to resolve its pin — offline, a warning and a fallback rather than a failure, but a network
call from a container that should never make one. The stub is how pnpm finds its pinned version
without the network. Both Dockerfiles now make it readable instead, and pnpm then answers 12.6.0 under
`--network none` with no warning in either image.

The bump is recorded here rather than left implicit because the lesson below is about pins that stop
being revisited, and a pin nobody has moved in a while is the thing that lesson is about.

**The general lesson, which is the reason this is written down:** a pinned tool that has not been
revisited in a while is not a stable dependency, it is a deferred migration. Four behaviours changed
under a field that looks like a version number, and three of them would have surfaced as a broken
production install rather than a failed test.

---

## ADR-030 — Tenant isolation is a data-layer filter that throws when it is absent

**Context.** Phase 2 enforced tenancy by remembering. `UsersController` computed
`isMspRoot ? null : ownTenantId` and passed it down; every future list endpoint would have had to do
the same. That is correct exactly as long as nobody forgets, and the failure mode of forgetting is
another customer's rows in a response — the single worst bug this product can have.

**Decision.** Move the filter underneath the application. A Prisma client extension rewrites every
query against a tenant-scoped model to carry the caller's scope, and a query that runs with **no
scope resolved at all throws** rather than returning everything. The scope is filled in by the auth
guard once the principal is known; until then every request is in the throwing state.

`withSystemScope("reason")` is the only way past. It takes a written reason, it is deliberately
greppable, and it has four callers — authentication (finding an account by email is what *decides*
which tenant a request belongs to), the setup wizard (it creates the first tenant there is), the
audit writer, and the guard resolving a principal.

**Why the default is "throw" rather than "empty".** An empty result is indistinguishable from a
tenant with no rows, so a missing scope would look like a working feature with nothing in it. A
throw is a stack trace in a test, which is where it belongs. The cost is that any new code path
running outside a request fails loudly until someone decides what it should be scoped to, and that
is the point.

**Why a GLOBAL grant lifts the filter, not `isMspRoot`.** Membership of the MSP organisation is where
someone's account lives; a GLOBAL grant is what they were actually given. An account in the MSP
tenant that was granted one customer should reach exactly that customer. A database trigger already
refuses a GLOBAL grant to anyone outside the MSP root tenant, so the narrower test is also the safe
one.

**What it cost.** Three things that were not obvious until they broke:

- The scope has to go into `where.AND` with the caller's own keys left at the *top level*. Wrapping
  the whole filter reads better and breaks `findUnique`, `update` and `delete`, because Prisma
  requires a unique field at the top level and answers *"Argument where needs at least one of id"*
  when it is nested. Written the wrong way first.
- An `AND` the caller already supplied must be appended to, not replaced. Replacing it drops their
  condition, which *widens* the query — the one direction a security filter must never move.
- `role_assignments.tenant_id` is null for a GLOBAL grant, so filtering on that column would have
  shown every MSP-wide grant to every tenant. Grants are scoped through the account they sit on.

**Also.** `@RequirePermission` with no scope resolver silently means "a global grant or nothing",
because an empty target matches only GLOBAL. Every administration endpoint was written that way,
which meant a tenant administrator holding `users.manage` at TENANT scope could not administer their
own tenant's accounts — invisible on an installation with one tenant. `RequirePermissionSomewhere`
is the fix for endpoints whose scope is a property of a row nobody has read yet: the guard refuses
anyone who does not hold the permission anywhere, and the service checks the precise scope once it
has the row. It is only ever correct as a pair, and the weaker decorator alone would be a real
weakening.

**Consequences.** Forgetting an authorization check no longer leaks data; it only fails to check
whether the caller was allowed to ask. Raw SQL remains banned by ESLint with a documented allowlist,
because it bypasses this layer entirely. PostgreSQL row-level security stays deferred to phase 15 as
a third layer, recorded in known-gaps.md rather than silently skipped.

**Amended in Phase 5 — tables that reach a tenant through a relation.** The schema guard above only
looked for a `tenantId` column. The job system's steps, events and logs have none: they reach their
tenant through their job. Leaving one of them out of `TENANT_SCOPED` would have passed that guard
and let anyone who guessed a job id read another customer's job output. The guard now also requires
every model with a relation to a scoped model to be scoped itself, or named in the test with the
reason it need not be. Six existing tables are named — authentication and secret internals read by
the account's or credential's own id — and removing `JobEvent` from the scoped list fails the test by
name.

---

## ADR-031 — Certificate pinning, and the two ways connection reuse defeated it

**Context.** A Proxmox node presents the certificate its own installer generated. It is not in any
trust store and cannot be, so the choice is between pinning a fingerprint an operator confirmed out
of band and having no verification at all. Pinning is strictly stronger than certificate-authority
verification here: it identifies one specific certificate rather than anything a trusted authority
happens to have signed.

**Decision.** Pin the SHA-256 fingerprint per cluster, confirmed by the operator against
`pvenode cert info` before any credential exists in the form, and check it **during the handshake**
— before the request line, and therefore the API token, is written to the socket. A mismatch closes
the connection with the credential still unsent, and is never retried: it is not a hiccup, it is
"this host is not the one you pinned".

**What it cost.** Two failures, both found by `scripts/verify-proxmox.sh` against a fixture, and both
invisible to every unit test — because neither is a property of the comparison. They are properties
of a real TLS stack talking to a real server.

1. **Reused sockets never fire `secureConnect`.** The check listened for that event, which happens
   exactly once per connection. Node's global agent keeps connections alive, so the second request
   reused the socket and the pin was silently skipped. A cluster added with a deliberately wrong
   fingerprint was accepted, connected and fully discovered. A verified socket is now *marked* with
   the fingerprint it was checked against, every request checks the mark rather than assuming a
   handshake it did not witness, and each client owns its own pool — never the global agent, which is
   shared with every other host in the process.

2. **Resumed sessions carry no certificate.** With the pool fixed, five of every six per-node calls
   failed with "completed a TLS handshake with no certificate": a resumed TLS session skips the
   certificate exchange, so there is nothing to compare. The failure direction was right — it refused
   rather than trusted — but most of the inventory came back empty. Sessions are therefore not
   cached. Pinning means seeing the certificate, and a full handshake per new connection is its
   price; open connections are still reused, which was most of the saving anyway.

**Consequences.** The one `rejectUnauthorized: false` in the Proxmox transport is load-bearing and
argued for inline, and the ESLint rule that bans it now also catches the non-literal form — because
`rejectUnauthorized: someVariable` is exactly the shape this needed, and a rule a variable defeats is
not a rule.

A certificate that legitimately changes — a renewal, a rebuilt node — fails closed and has to be
re-confirmed. That is the point: a renewal and an interception look identical to software, and only a
person looking at the node can tell them apart.

---

## ADR-032 — Acceptance is proven against a fixture that answers over a real socket

**Context.** Phase 4's acceptance criteria say "a real (or fixture-backed) cluster can be added".
Nobody has a Proxmox cluster in CI, and the obvious substitute — mocking the client — proves only
that the mock was written to agree with the code that calls it.

**Decision.** Ship a fixture Proxmox API: a small HTTPS server with a real self-signed certificate,
answering the endpoints Velnox actually calls with the response shapes PVE 8 returns, run on the
network the worker uses. `scripts/verify-proxmox.sh` drives the whole flow through Velnox's own API
— probe, confirm, add, discover, read back, pull the plug — and asserts fifty things.

**What makes it worth having is what it gets wrong on purpose.** One node is offline, one node
refuses `/apt/repositories` with a 403, Ceph has `noout` set and one daemon a release behind. Those
are the paths that are otherwise described rather than exercised, and they are where an inventory
starts quietly lying.

**It found three bugs in its first run**, all of them in code that had passed review and a hundred
unit tests: both halves of ADR-031, and a failed verification that left a half-added cluster behind.
It also found a fourth in itself — every status assertion was reading the status of the previous
request, because `X="$(call …)"` runs in a subshell.

**Consequences.** Unit tests keep proving the decisions: what is retryable, how a byte count is
formatted, what counts as healthy. Anything that is a property of a socket, a pool or a deployment is
proven here instead, because that is the only place it is true. `verify-tenancy.sh` exists for the
same reason and about the same boundary.

---

## ADR-033 — Alerts are derived from the inventory, not stored

**Context.** Phase 4 has to surface a cluster left with `noout` set, a node that is offline, a
cluster that has lost quorum. The obvious shape is an `alerts` table.

**Decision.** Compute them from the inventory on every request instead. No table, no acknowledgement,
no silencing, no notification.

**Why.** A stored alert needs a lifecycle — raised, acknowledged, resolved, re-raised — and every
part of it can be got wrong in a way that is worse than not having it. An alert that stays after its
cause is gone teaches people to ignore the screen; one that re-raises on every discovery run teaches
them the same thing faster. Derived alerts cannot be stale: the condition is read at the moment the
question is asked, and an alert disappears the instant its cause does.

**What it costs, and where it is written down.** Nothing reaches anyone who is not looking at the
screen, and there is no history of what was alerting last Tuesday. Both are in known-gaps.md and both
want the job system underneath them, which is Phase 5. Building half of it now would mean migrating a
half-built lifecycle later, from data operators had started to rely on.

---

## ADR-034 — The inventory screens refresh themselves, and there is no "read now"

**Decision:** The cluster list and the cluster page re-read themselves every two seconds. A
**Refresh** button does the same read on demand. The **Read now** button, which queued a discovery
run against Proxmox, is gone.

**Why the button went.** It looked like a refresh and was not one. It queued a job, returned
immediately, and left a screen that looked exactly as it had a moment earlier — so the natural
reading was that nothing happened, and the natural response was to press it again. What an operator
usually wants from a button in that position is the screen showing current data, and that is a page
re-read: local, cheap, and instant.

**What refresh does not do.** It does not reach Proxmox. Both the interval and the button re-read
what Velnox already holds; the reading of the hypervisor happens on each cluster's own schedule.
Saying so in the documentation matters more than it sounds, because the word invites the opposite
assumption.

**Cost, stated plainly.** There is now no way to force a discovery run outside the schedule. What
remains is the per-cluster interval, which can be shortened and set back. That is a real loss for
the case of "I have just fixed the firewall and want to see it work", and it is worth reversing if
that case turns out to be common — as a clearly separate action, not as a button labelled like a
refresh.

**Why polling, and why two seconds.** There is no stream yet; the job system and its progress
channel arrive in phase 5, and this is what stands in until then. Two seconds is the cadence the
owner asked for. Each tick is one page re-read — for the list, one cluster query per open tab — so
it is not free, and it does not run in a hidden tab: the interval stops on `visibilitychange` and
refreshes once on the way back, because six forgotten tabs polling for a week is a cost nobody
chose. When the stream lands, this is the thing it replaces.

**It pauses while someone is in the middle of something.** Adding a cluster is three steps with a
fingerprint to compare against another screen, so it is precisely the thing an operator leaves and
comes back to — and the refresh that fires on the way back was taking the half-filled form with it.
The interval is off while that form is open, and while a removal is being confirmed.

That is a workaround as much as a preference, and the underlying problem is worth stating:
`router.refresh()` re-renders the **layout** as well as the page, and the shell layout returns
`<SessionRecovery />` instead of the whole application when `getSession()` comes back empty — an
expired access token, or an API call that took longer than five seconds. Replacing the tree unmounts
everything below it. On navigation that is rare enough to be invisible; at one refresh every two
seconds it stops being rare. Pausing where it hurts most is not the same as fixing it.

---

## ADR-035 — A job is a row first, and a worker holds it by a lease

**Decision:** A job exists in the database before it exists anywhere else. The queue carries a job
id and nothing more; everything about the job — its status, its steps, its events, its output — is
in PostgreSQL. A worker that takes a job holds it by a **lease** it renews every ten seconds, and
every status the worker writes is conditional on still holding it. A job whose lease lapses is
failed with `job.worker_lost` and **never retried automatically**.

**Why the row first.** Redis is the queue, and a queue is allowed to be lossy in a way a record is
not. A flushed or rebuilt Redis loses queue positions; it must not lose the history of what was done
to a customer's cluster. With the row as the record, the worst case of a lost queue entry is a job
visibly stuck in *Queued*, which a person can see and act on.

**Who may move a job where.** Ownership is split by status, and it is what makes simple conditional
writes sufficient:

- **Queued** and **Waiting for approval** belong to nobody. The API moves them: cancelled before
  starting, approved back onto the queue, rejected.
- **Preflight**, **Running** and **Validating** belong to one worker. The API never writes their
  status; cancelling one sets a flag the worker honours at the next safe point.

Every write names the status it expects. If the API reads *Queued*, a worker claims the job, and the
API then tries to cancel it, the API's write misses and it falls back to the running-job path. No
locks held across requests, no distributed coordination.

**Why a lease, and why conditional on it.** A worker that crashes never says so. The lease is how
the others find out: lapsed, and the job is failed as lost by whichever worker's reconciler notices
first, at startup or on its fifteen-second tick. The conditional write covers the other half: a
worker that was merely *slow* — a long garbage-collection pause, a database stall — and wakes up
after its job was reconciled cannot then write *Succeeded* over *Failed*. Its write misses, and it
stops.

**Why no automatic retry.** BullMQ's default is to hand a stalled job to another worker. For a job
halfway through changing a cluster, that means doing the first half twice, and nothing in Proxmox or
apt promises the first half is idempotent. The job queue runs with `maxStalledCount: 0`, and a lost
job is reported as lost, with the step it was on. A person decides whether to retry, and a retry is
a **new** job pointing at its parent, so the failed attempt's history is never rewritten.

**The state machine is shared.** `packages/shared/src/jobs.ts` holds the transition table used by
both the worker and the API. A test walks all hundred ordered pairs of statuses, and another reads
the migration to check that the database's list of active statuses — the one that decides which jobs
hold a concurrency key — is the same list.

**Four-eyes governs approving, not declining.** A gate that requires a second person stops the
requester from approving their own change. It does not stop them rejecting it: declining your own
request is withdrawing it, which they could do anyway by cancelling. The first version blocked both;
`verify-jobs.sh` caught it.

**Cost.** A lost job takes about half a minute to be noticed: the thirty-second lease, plus up to
one reconciler tick. Measured at 33–34 seconds from `SIGKILL` to *Failed*. A shorter lease would
notice sooner and would also mistake an ordinary pause for a death more often; thirty seconds is
the trade.

---

## ADR-036 — Live job events: listen first, replay second, number everything

**Decision:** A job's events are streamed to the browser over **server-sent events**, fanned out
from Redis pub/sub. Every event has a per-job sequence number with no gaps; the stream attaches its
listener **before** reading history; every message on the wire that is not a comment carries a real
sequence number as its id; and the stream ends with a `done` event the browser closes on.

**Why SSE and not WebSockets.** The traffic is one-way, the browser's `EventSource` reconnects on its
own and sends `Last-Event-ID` when it does, and it travels over the same origin, cookie and proxy as
every other request. A WebSocket would add a second protocol through Caddy to gain a direction
nothing uses.

**Gapless sequence numbers.** The number comes from incrementing `jobs.event_seq` inside the
transaction that inserts the event, which row-locks the job. Two writers — a worker and an API
cancelling — serialise, and a rollback takes the increment with it. That is what lets a reconnecting
browser say "everything after 41" and get exactly that.

**Listen first, replay second.** An event published between "read history" and "start listening"
would fall into the gap and never arrive. So the listener is attached first and buffers, history is
read and sent, then the buffer, and sequence numbers make any overlap harmless.

**Every id is a real one.** NestJS stamps any SSE message *without* an id with a per-connection
counter of its own — 1, 2, 3 — and a browser keeps whichever id it saw last. The first version sent
its heartbeat and its closing `done` without ids, so a browser's place in the stream could become
Nest's number instead of the job's, and a reconnect would replay from the wrong point. Found by
`verify-jobs.sh`, whose sequence check saw ids that were not the job's. The heartbeat is now an SSE
comment, which browsers ignore and Nest does not number; `done` repeats the last real id.

**Why `done`.** `EventSource` reconnects whenever a connection closes, including when the server
closes it on purpose. Without a signal to stop, a finished job's page would reconnect every few
seconds for ever. On `done`, the page closes the stream; and a reconnect to a job that is already
finished gets `done` at once rather than an open connection that will never say anything.

**One subscriber per API process.** A Redis connection in subscriber mode can do nothing else, so
one pattern subscription per process fans out to every open stream, rather than one connection per
browser tab.

**Cost.** Each event is a database write and a publish. The self-test's ten progress reports per
step are the busiest case so far; a playbook that reports progress more often than a person can read
it should report less often.

---

## ADR-037 — The ISO library, and the first time Velnox writes to Proxmox

**Decision:** The library is **one store for the whole installation**, in its own Docker volume, with
two limits checked before anything is written. Every movement of a file — fetching it from a URL,
checking an upload, pushing it to a cluster, pulling it back, deleting it from a cluster — is a
**job**, and every job that does not finish leaves nothing behind on either side. Pushing to a
cluster goes through Proxmox's own upload call, which makes this the first time Velnox changes
anything on a customer's infrastructure.

**One store, no tenant.** `library_items` has no tenant column and no relation to anything that has
one. An ISO of Windows Server is the same file for every customer, and a store per tenant would hold
it once per customer on the same disk. Reading the library is `library.read`, which every role holds,
because from Phase 5B a tenant chooses from it. Adding and removing is `library.manage`, held by MSP
roles only: a customer filling the library fills it for everyone. Putting a file *on a cluster* is
not a library permission at all — it writes to somebody's infrastructure, so it is `clusters.manage`
on that cluster, checked once the cluster is known.

**Two limits, both named when they refuse.** `VELNOX_LIBRARY_MAX_GB` is the library's own budget,
counting transfers still in progress. `VELNOX_LIBRARY_MIN_FREE_GB` is the disk's: by default the
volume shares a disk with PostgreSQL and Redis, and a full disk there is not a failed upload but an
installation that has stopped. Both are checked against what is still to be written — a resumed
upload has already written part — with space promised to transfers already under way subtracted
first, so two uploads that each fit cannot together overfill it. A refusal says which limit and the
numbers ("the library holds 95 of 100 GB"), because *disk full* tells an operator nothing about what
to change.

**Two ways in.** A URL, which the worker fetches, and a browser upload, which the API receives in
32 MiB chunks. Chunks are the price of an upload that survives a dropped connection: each chunk says
where it starts, a chunk at any other offset is refused with the offset the server has, and the
browser resumes from there. A refused chunk's body is still read before the refusal is sent; answering
early and closing let the client's TCP stack reset the connection and throw away the very answer that
told it where to resume. `verify-library.sh` caught it, intermittently, which is the worst way.

**A URL fetch is server-side request forgery unless proven otherwise.** The worker is the process
with a route into customers' management networks, and the address is chosen by whoever adds the URL.
Refused: loopback, link-local (cloud metadata), multicast, carrier-grade NAT, and **every network the
worker is itself attached to**, which is how Velnox's own database and Redis are reached. Allowed:
everything else, private ranges included — an MSP's ISOs very often sit on an internal file server,
and refusing RFC 1918 would make the feature useless on exactly the networks it is for. The check is
made on the address the connection will use: the resolver's answer is checked and that address is
dialled, so a name that answers differently a second time gains nothing. No https-to-http redirect,
at most five redirects each judged afresh, no credentials in the URL, certificates verified with no
switch to turn that off, and the byte limit enforced while bytes arrive. The address shown and logged
has its query string removed, because signed download links carry their signature there — and once
the download is over, successful or not, so does the stored one. The full address exists only for as
long as something needs to fetch from it.

**The name says what it is; the bytes have to agree.** A file named `.iso` must carry an ISO 9660 or
UDF descriptor, a disk image named `.qcow2` or `.img` must start with the qcow2 magic, and a mismatch
fails the check with the reason on the item. The SHA-256 is computed on the way in and is the value
every later push is checked against.

**Friendly names are parsed, and correctable.** `Windows11_25H2_Dutch.iso` reads as *Windows 11
Version 25H2 Dutch*, or *… Nederlands* for a viewer reading Velnox in Dutch, because the language is
stored as a tag and named in the viewer's language. A filename parser is a heuristic and a wrong
confident label is worse than an honest raw one, so both the title and the language can be
overridden, and every log line names the real filename.

**The push.** Proxmox's `upload` call takes the file as a multipart body with a checksum. Velnox
streams it from the volume, starting the body only once the TLS pin has passed — the certificate is
checked before a single byte of the file leaves — and sends the SHA-256 so Proxmox verifies the file
on arrival and refuses a mismatch itself. Before sending, a **check** step confirms the storage is
enabled, takes that content type, has room, and does not already hold a file of that name. That last
point is what makes cleanup safe: having proved the name was free, anything at it after a cancelled
or failed push is this job's own half-finished work, and is deleted. A file that was already there is
refused, never overwritten. After the upload, a **confirm** step reads Proxmox's own content list and
checks the size — an upload call returning success is not the same as the file being there.

Disk images go up as `import` content, the type Proxmox reads a disk from when a VM is created from
it, under a `.qcow2` or `.raw` name because Proxmox decides how to read an import by its extension.

**Cleanup before the final state.** A job's cleanup runs before the job is recorded as finished, and
a cleanup that fails is its own recorded outcome (`job.cleanup_failed`), not a success with a
footnote. A worker that dies cannot clean up after itself, so a **sweeper** runs at worker start and
every fifteen minutes: items a dead job was writing are failed as `job.worker_lost`, uploads silent
for a day are removed, files with no row are removed, and rows whose file has gone are failed as
`library.file_missing` so the screen stops offering them.

**Alternatives considered.** A library per tenant (rejected: the same file stored once per customer,
and nothing a tenant needs that `library.read` does not give). Streaming a URL straight to the
cluster without keeping a copy (rejected: every push would download again, and nothing would have
been checked before it reached a customer). Pushing over SSH (rejected: the API's upload call exists,
verifies the checksum itself, and needs nothing on the node that Velnox does not already have).

**Cost.** The library is a second large thing on the Velnox host to back up, or deliberately not to.
Its files are replaceable — they came from somewhere — so the backup guidance treats the volume as
optional, and the rows as part of the database.

---

## ADR-038 — SSH on a cluster: optional, SFTP only, host keys pinned

**Decision:** Copying a file *off* a cluster uses SSH, configured per cluster and off until someone
sets it up. The worker opens **SFTP and nothing else** — there is no code path that runs a command.
Each node's host key is read, shown and confirmed before any credential is offered, exactly as a TLS
fingerprint is when a cluster is added (ADR-031).

**Why SSH at all.** Proxmox's API can put a file on a storage and can delete one, and has no call to
read one back; the only download it offers is file-restore from Proxmox Backup Server. Pulling an ISO
from a cluster into the library therefore needs another way in. The owner chose SSH, per cluster and
optional, over the alternatives below.

**Set up the way a cluster is added.** A **probe** connects to every online node, records the host
key it presents, and ends the handshake before user authentication — no username and no key are ever
sent to a host nobody has confirmed. The operator compares the fingerprints against the nodes
(`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`) and confirms. **Configure** then stores the
private key encrypted in the secret store, pins each node's key, and proves the key opens SFTP on
every pinned node. If any node refuses, everything this call stored is taken back out and the
previous set-up, if there was one, is left as it was. The private key is never returned by any
endpoint.

**A different key refuses the connection before the credential is offered**, the same rule as the
TLS pin. A node that has been reinstalled has to be confirmed again, deliberately.

**Where the file is.** Velnox does not guess paths on a node. It asks Proxmox's API for the volume's
path and uses it only if it is absolute, contains no `..`, and ends in the expected filename — the
path comes from the node, and is used for exactly one read.

**What the account needs.** Read access to the storage directories, and nothing else. An operator can
give it an SFTP-only login (`ForceCommand internal-sftp`) and lose nothing Velnox uses; the guide
recommends it.

**Alternatives considered.** Streaming through Proxmox's `download-url` in reverse (does not exist).
A backup-and-restore round trip through PBS (heavy, and not every cluster has PBS). Exec over SSH
with `cat` or `rsync` (rejected: it needs a shell, and a shell is a much larger thing to hand a
service than a file read). A per-node agent (rejected: something to install and keep updated on
every customer node, for one feature).

**Cost.** Another credential per cluster, and another set of fingerprints to confirm and re-confirm
after a reinstall. SSH is also the first connection to a node that is not the Proxmox API, which
Phase 10's credential rotation will build on — the reason `nodes` had reserved a host-key column
since Phase 4.

---

## ADR-039 — Provisioning: answer media on a CD, one credential per secret, a reveal that is audited

**Decision:** A VM is built from an Autoconfig template by one job, `vm.provision`. The guest is
handed its configuration on a small ISO the job writes — `Autounattend.xml` for Windows, a
cloud-init NoCloud seed for Linux — which is deleted from the storage when the job ends, however it
ends. Every secret is its own credential. A VM's passwords are decided once, stored as that VM's
credential, and shown to a person only through an audited reveal.

**Why a CD.** Windows Setup reads `Autounattend.xml` from the root of any removable drive, and
cloud-init's NoCloud source reads a volume labelled `cidata`. Proxmox can attach an ISO from any
storage that takes `iso` content, and the upload call the library already uses (ADR-037) puts one
there with its checksum verified. Proxmox's own cloud-init drive was the obvious alternative and lost:
anything beyond its few built-in fields needs a `snippets` storage and a file written to it, which
the API cannot do — it would need SSH, which is optional (ADR-038). The ISO is written by a small
ISO 9660 writer with Joliet names; `blkid`, `isoinfo` and the Linux kernel read what it writes as
intended.

**Linux from cloud images, not installers** — settled with the owner: usable in seconds, identical
every time. Passwords go to cloud-init as SHA-512-crypt hashes, never in the clear; `user-data` is
written as JSON under `#cloud-config`, which YAML parses, so nothing depends on hand-rolled quoting.
`cloud-init schema` accepts the output on the oldest and newest cloud-init the images ship.

**Windows: what makes it unattended.** The edition is chosen by `/IMAGE/NAME`, from a list read out
of the ISO's own `install.wim` (UDF and WIM read just far enough) — a name that is not in the ISO
installs the first edition instead, silently, so the form offers only names the ISO has. VirtIO
storage drivers load during Setup from the driver ISO. One auto-logon runs the commands that install
the drivers and the guest agent, then removes the auto-logon and the cleartext `DefaultPassword`
Windows otherwise leaves in the registry, and writes a marker file last. UEFI Windows media ask for
a key before they boot; the job presses Enter for the first twenty seconds after start, and later
reboots time out to the disk.

**Done means the guest says so.** The install is finished when the guest agent can read the marker
written last. Not "the VM rebooted" or "it has an address": both happen halfway through.

**A failed install leaves nothing.** Cleanup — run before the job records its end (ADR-037) —
stops and destroys the VM with its disks, deletes the answer ISO and any half-sent upload, and drops
the passwords. If the VM cannot be destroyed, the job fails as `provisioning.cleanup_failed` with
the VMID, because a VM Velnox made and could not remove is for a person to look at. Requests that
change a VM are sent once and never retried: a create whose answer was lost must not be repeated.

**Secrets.** A template's fixed passwords, product key and PDF password are one `TEMPLATE_SECRETS`
credential each. The API writes them and cannot read them (ADR-009), so changing one must never need
another decrypted; one blob would have. A clone therefore copies settings and not secrets — which is
also the right answer, since an MSP's fixed passwords should not reach a customer by copying a
template. A VM's passwords are decided by the worker (it is what can read a template's fixed ones),
stored as a `GUEST_CREDENTIALS` credential before anything uses them, and dropped thirty days after
hand-over.

**The reveal, and the amendment to ADR-009.** `GUEST_CREDENTIALS` is the one infrastructure-adjacent
kind the API may read, and only in `ProvisioningService.reveal`: `clusters.manage` on the cluster,
written to the audit trail before the answer leaves — refusals too — and an answer with an expiry the
page honours. That is the explicit break-glass the project's rules allow for a password reaching the
frontend. ADR-009's point stands: the API still decrypts nothing it would use against
infrastructure.

**The installation record.** Mailed once — the row is claimed before the mail goes — with no
password in the body. Without passwords for `VELNOX_ONLY`; with them for `ENCRYPTED_PDF`, encrypted
AES-256 **revision 6**. pdfkit writes revision 5, whose password check is one SHA-256 and which ISO
32000-2 deprecated for being cheap to guess against; the file key is the same in both, so it is
rewrapped with Algorithm 2.B before pdfkit writes the dictionary. That reaches into pdfkit, which is
therefore pinned. The PDF's password never travels in the mail: it is shown once to whoever asked, or
set on the template.

**Outgoing mail: enabled means proven.** The worker sends, because it may read the server's
password. Changing the connection switches mail off until a test has gone out with the new settings.

**Alternatives considered.** Proxmox's cloud-init drive (needs snippets, and so SSH). An answer
file served over HTTP from Velnox (the guest would need a route to Velnox, which customer networks
often do not give). A Windows install from a sysprepped template VM (fast, and a different product:
it needs a golden image per customer and per edition, kept patched). Running the guest agent's
`exec` to watch the install (it would give the job a shell into every customer VM; a file read is
enough).

**Cost.** The answer ISO holds unattend's reversible passwords on the node's storage for as long as
the install runs. The fixture proves the whole flow but installs nothing; whether a real Setup and a
real cloud-init accept what they are handed is proven by the generators' tests and the formats' own
validators, and is listed in the known gaps until it has been seen on a real cluster.

---

## Version targets

| Component | Version |
|---|---|
| Node.js | 22 LTS |
| pnpm | 12.x (Phase 0 said 9.x; see ADR-029 for the 10 → 12 move) |
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

*The Velnox name and logo are used by The Velnox Foundation. No trademark is registered or claimed; the AGPLv3 grants no rights in either. Velnox is free software under the AGPLv3.*

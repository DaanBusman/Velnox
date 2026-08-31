# Velnox — Technical Risk Register

**Status:** Phase 0. Risks are ranked by *expected damage*, not by likelihood alone: this product
holds root credentials for other companies' production hypervisors and reboots them.

Scoring: **Impact** (1–5) × **Likelihood** (1–5) = **Risk**. Anything ≥ 12 needs a mitigation
landed in the same phase as the feature that creates it.

---

## Tier 1 — could destroy customer infrastructure or leak customer secrets

### R-01 · Cross-tenant data leak (Impact 5 × Likelihood 3 = **15**)
One forgotten `where: { tenantId }` exposes customer A's nodes, credentials or audit trail to
customer B. This is the single worst outcome for an MSP tool.

**Mitigation:** defence in depth, not diligence. (a) Prisma client extension injects the tenant
filter on every tenant-scoped model and **throws** when no request context is present; (b) explicit
RBAC guard with a scope resolver; (c) ESLint ban on raw SQL; (d) a CI-blocking test suite that, for
*every* tenant-scoped resource, asserts a tenant-A user gets 403/404 on read **and** write of a
tenant-B object — including nested routes, list endpoints, filters, sorts and job targets;
(e) PostgreSQL RLS on the highest-risk tables as Phase 15 hardening.
**Residual:** raw SQL in an allowlisted file is still a hole. Every allowlist entry needs a review.

### R-02 · Secret leakage through logs, job output or API responses (5 × 3 = **15**)
Passwords appear in `ps` output, shell history, `apt` logs, PVE task logs, exception messages and
stack traces far more easily than people expect.

**Mitigation:** never pass secrets as process arguments — `chpasswd` receives them on stdin over
the SSH channel; typed `JobEvent` payloads instead of raw output; pino redaction plus a
value-matching sweep before any log/event/audit insert; the API has **no code path** returning
plaintext material; a dedicated test asserts that a rotation job's full event stream, logs and API
responses contain no substring of the generated password.
**Residual:** a third-party library logging a connection URL. Mitigated by redaction on the sink.

### R-03 · Rolling update takes a cluster below quorum (5 × 3 = **15**)
Rebooting one node too many turns a maintenance window into an outage, and Ceph adds a second,
independent quorum to respect.

**Mitigation:** the invariant lives in one place, not in each step — at no moment may unavailable
quorum-voting nodes exceed `⌊(n-1)/2⌋`. Default concurrency 1. Refuse to start on an already
degraded cluster. Re-verify quorum and Ceph health *before each node*, not once at the start.
`concurrency_key = cluster:<id>` with a partial unique index makes two concurrent jobs on one
cluster impossible even across workers. Property-based tests over cluster sizes 1–15 assert the
invariant holds for every schedule the planner can emit.

### R-04 · Major upgrade bricks a node (5 × 3 = **15**)
PVE 8 → 9 crosses a Debian major release. A half-completed `dist-upgrade`, a wrong repository, or a
reboot into a broken kernel means an on-site visit.

**Mitigation:** blockers stop the run — Velnox never "proceeds anyway"; unparsed `pve8to9` output is
treated as a blocker; upgrade one node and **require an explicit continue** before the rest (first
node is a canary, on by default); configuration files are backed up before modification;
cancellation never kills an in-flight `dist-upgrade`; post-upgrade validation must pass before the
next node starts. Velnox cannot roll back a Debian major upgrade — this is stated in the UI before
the operator confirms, and a PBS/host backup is a documented precondition.
**Residual:** genuinely unrecoverable failures remain possible. Honest documentation, not a false
promise of rollback.

### R-04b · Ceph upgrade damages the storage layer (5 × 3 = **15**)
A Ceph release upgrade restarts every storage daemon in the cluster. Restarting OSDs too quickly,
proceeding on a degraded cluster, or raising `require-osd-release` before all OSDs have converged can
take placement groups offline — which means every VM on that storage stops, across all nodes at once.
Worse, it is silent for a while: PGs degrade before they become unavailable.

**Mitigation:** strict daemon ordering (MON → MGR → OSD → MDS → RGW) with health revalidated between
every group *and* every node's OSDs, never a batch restart; `HEALTH_OK` plus all PGs `active+clean`
plus full MON quorum required before start and re-checked continuously; a capacity guard ensuring the
cluster tolerates one failure domain being down; a cluster with heterogeneous daemon versions is a
blocker rather than something to resume; unrecognised `HEALTH_WARN` states block instead of
continuing.
**Residual:** recovering a damaged Ceph cluster is genuinely expert work. Velnox stops and reports;
it does not attempt clever automated repair.

### R-04c · `noout` left set after an aborted Ceph maintenance (4 × 4 = **16**)
`noout` suppresses automatic rebalancing. Left set after a failed or cancelled run, the cluster looks
healthy while silently having no self-healing — until a disk dies weeks later and nothing recovers.
This is the classic Ceph operational time bomb, and an orchestrator is *more* likely to cause it than
a human, because a crashed process never runs its cleanup.

**Mitigation:** flag cleanup is a guaranteed step on every exit path — success, failure and
cancellation — not a happy-path step; on worker restart the reconciler checks for flags set by an
orphaned job and clears or escalates them; `ceph_flags` is inventoried on every discovery and alerted
on regardless of which tool set it, including a human at the CLI. A test kills the run mid-flight and
asserts the flag is cleared.

### R-05 · Loss of `MASTER_ENCRYPTION_KEY` (5 × 2 = **10**, but unrecoverable)
Without the master key, every stored credential is permanently unreadable.

**Mitigation:** the installer prints a loud warning and the key location; the backup documentation
leads with it; `/readyz` fails fast on a key that cannot decrypt existing rows (rather than
silently returning errors later); key versioning plus a `rewrap` operation supports rotation and
recovery drills. A future KMS backend removes the single point of failure.

---

## Tier 2 — likely to bite during implementation

### R-06 · `pve8to9` output format changes between releases (4 × 4 = **16**)
It is a human-oriented CLI, not a stable API. A parser that silently drops an unknown line lets a
real blocker through.

**Mitigation:** `UNKNOWN` severity is treated as a blocker requiring human review; the parser is
versioned and `parser_version` is stored on every check; the raw output is always retained; a
golden-file test suite covers real outputs from multiple PVE point releases; the UI shows unparsed
lines verbatim rather than hiding them.

### R-07 · Proxmox self-signed TLS (4 × 5 = **20** if handled naively)
The overwhelmingly common shortcut is `rejectUnauthorized: false`, which makes every Velnox → node
connection MITM-able across a customer WAN — while holding root credentials.

**Mitigation:** no insecure mode exists in the code. Trust-on-first-use with the fingerprint shown
for explicit confirmation, pinned on the row, verified on every connection; a mismatch is a hard
failure plus an alert; a custom CA bundle is supported as the better alternative. The TOFU
confirmation is audited with the fingerprint recorded.

### R-08 · SSH host key trust (4 × 4 = **16**) — same class as R-07, same treatment
TOFU with explicit confirmation, pinned fingerprint, mismatch = hard failure. No
`StrictHostKeyChecking=no` equivalent anywhere.

### R-09 · Hyper-V has no REST API (3 × 5 = **15** to schedule, not to safety)
Discovery requires WinRM/PowerShell remoting with NTLM or Kerberos; VHDX transfer requires SMB or
SSH reachability that many environments will not grant to a Linux appliance.

**Mitigation:** scope v1 honestly — full discovery and planning, plus an **operator-assisted**
transfer step that is labelled as such in the UI. No fake automation, no fake progress bar. Document
exactly which network paths and privileges a fully automated transfer would need, so it can be
added later.

### R-10 · VMware transfer is a large problem to reimplement (3 × 4 = **12**)
Writing our own VDDK/OVF pipeline is months of work and a support burden.

**Mitigation:** orchestrate Proxmox VE's native ESXi import storage (PVE ≥ 8.2) rather than
reimplementing it. Below 8.2, deliver discovery, compatibility assessment and a documented manual
procedure. The adapter interface keeps a future native pipeline additive.

### R-11 · ISO build needs privileges Docker Desktop cannot give (3 × 5 = **15** to schedule)
`live-build` requires loop devices and elevated privileges; it will not run on Docker Desktop for
Windows or macOS.

**Mitigation:** `build-iso.sh` preflights for a Linux host with the required capabilities and
**fails with a clear message** rather than producing a non-bootable file. The tar.gz and
self-extracting installer targets — which cover the actual acceptance criterion of installing on a
clean Debian box — have no such constraint and are delivered first.

### R-12 · Job/queue state divergence after a crash (3 × 4 = **12**)
A worker killed mid-job leaves a `RUNNING` row with no queue entry, or a queue entry with no row.

**Mitigation:** PostgreSQL is the system of record; on start the worker reconciles both directions —
orphaned `RUNNING` jobs older than the heartbeat threshold are marked `FAILED` with an explicit
`worker_lost` error (never silently retried, because a half-applied upgrade must not be blindly
repeated); steps are idempotent so an operator can safely resume.

---

## Tier 3 — quality, delivery and operational risks

| ID | Risk | Score | Mitigation |
|---|---|---|---|
| R-13 | **Scope.** 16 phases, ~9 major subsystems, now including Ceph upgrades, MFA and two languages. The realistic failure mode is a broad, shallow, half-working product. | 4×4=16 | Phase gates with explicit acceptance criteria; each phase must be demonstrably working, tested and documented before the next starts. Feature flags hide incomplete subsystems instead of shipping fake UI. The 2026-08-31 decisions grew scope by roughly one phase (9A) plus cross-cutting i18n work — accounted for in the roadmap rather than absorbed silently. |
| R-14 | Testing against real Proxmox requires hardware we may not have during development. | 3×4=12 | A recorded-fixture Proxmox mock built from real API captures for unit/integration tests, plus a documented manual verification checklist against a real cluster per phase. Fixtures are labelled as fixtures — the UI never shows fixture data as live. |
| R-15 | OIDC/Entra misconfiguration locks everyone out. | 4×3=12 | Local break-glass login cannot be disabled by SSO configuration; a "test connection" flow validates discovery, redirect URI and claims before SSO can be enabled; changes are audited. |
| R-16 | Long-running SSH sessions dropped by customer firewalls mid-upgrade. | 3×4=12 | Keepalives; detached execution with a resumable marker file on the node so a reconnect can determine what completed; never assume failure means "not applied". |
| R-17 | Approval fatigue — operators approving without reading. | 3×4=12 | Approvals show the exact `ChangeSet` diff, not a generic prompt; risky remediations are visually distinct; optional four-eyes; every approval is audited with the change set hash. |
| R-18 | Windows-based development, Linux-based deployment (line endings, permissions, path separators). | 2×5=10 | `.gitattributes` enforcing LF for shell scripts; all shell scripts linted with shellcheck in CI; container builds are the source of truth for anything path-sensitive. |
| R-19 | Time-zone handling in maintenance windows. | 3×3=9 | Store RRULE plus IANA timezone; evaluate server-side in the window's own zone; never in the browser's. |
| R-20 | Audit log growth and retention vs. immutability. | 2×4=8 | Append-only trigger; hash chain; retention pruning by a separate role, itself audited; documented export before pruning. |
| R-21 | Supply chain (npm dependency compromise) in a tool holding root credentials. | 5×2=10 | Lockfile committed; `pnpm audit` and a CI SCA gate; pinned base images by digest; minimal dependency surface in `packages/crypto` and `packages/remote-exec`; no post-install scripts allowed for new dependencies without review. |
| R-22 | **MFA locks out the last administrator.** Enabling `REQUIRED` while the only Super Administrator has an unenrolled or lost authenticator makes the installation unadministrable. | 4×3=12 | Enrolment must be confirmed with a working code before a factor activates, so a half-finished setup can never become the enforced factor; recovery codes are generated and shown at enrolment, and the policy cannot be raised to `REQUIRED` unless at least one Super Administrator has a confirmed factor **and** unused recovery codes; a documented offline reset procedure via the database exists and is itself audited. |
| R-23 | **Translation drift.** Dutch documents silently fall out of date — worse than not having them, because a reader cannot tell. | 3×5=15 | Each `docs/nl/` file records the git hash of the English source it was translated from; CI warns (never blocks) when the English counterpart has changed; the header of every Dutch document states that English is canonical. UI strings cannot drift: CI *fails* on a missing or extra locale key. |
| R-24 | **Dependency licence incompatible with AGPLv3** discovered late, forcing a rewrite of a UI or crypto component. | 4×2=8 | A CI licence check on every dependency addition from Phase 1, not a Phase 15 audit; component library chosen for a permissive licence with vendored source (shadcn/ui, MIT); `THIRD-PARTY-NOTICES.md` generated from the lockfile at build time so the picture is never stale. |
| R-25 | **Ceph/PVE version matrix goes stale** as upstream releases move, producing plans that are wrong rather than plans that refuse. | 4×3=12 | The matrix is data, versioned, and recorded on every plan (`version_matrix_id`) so old reports stay interpretable; it is *verified against the live cluster at plan time*, and disagreement between the running release, the target and the matrix refuses the plan while naming which of the three is unexpected. Velnox never guesses about version compatibility. |

---

## Decisions taken — 2026-08-31

| # | Question | Decision | Effect |
|---|---|---|---|
| 1 | Ceph upgrades | **In scope.** Separate playbook, composed before the PVE major upgrade. | New Phase 9A; Ceph inventory pulled forward into Phase 4; new risks R-04b, R-04c, R-25. |
| 2 | MFA | **Optional but recommended.** TOTP + recovery codes, three policy levels, `OPTIONAL` default. | Added to Phase 2; new risk R-22. |
| 3 | Air-gapped install | **Yes** — bundled images are the default tar artifact, `--slim` variant alongside. | Phase 14 acceptance now includes an install with outbound network blocked. |
| 4 | PBS | **Deferred** past v1. Framework stays ready for a PBS playbook. | Recorded in known-gaps.md. |
| 5 | Documentation language | **English + Dutch**, with a translation-ready glossary. English canonical. | New `packages/i18n`, `docs/i18n.md`, `docs/nl/`; i18n moved into Phase 1; new risk R-23. |
| 6 | Licence | **AGPLv3.** | §13 compliance is a product feature in Phase 1; CI licence gate; new risk R-24; `TRADEMARK.md` separates marks from the licence. |

## Open questions still outstanding

1. **Agentless only?** Everything above assumes no Velnox agent is installed on managed nodes. An
   optional agent would cleanly solve R-16 (dropped SSH sessions) and reboot-survival. Out of scope
   unless requested — it is a significant addition, so worth an explicit decision rather than drift.
2. **Trademark contact.** `TRADEMARK.md` needs a real contact address for permission requests before
   any public release.
3. **Copyright holder line.** `NOTICE` currently reads "Copyright (C) 2026 The Velnox Foundation".
   Confirm this is the intended holder, or name individual contributors instead.

---

*Velnox™ is a trademark of The Velnox Foundation.*

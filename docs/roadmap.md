# Velnox — Implementation Roadmap

**Status:** Phases 0 to 5 and 5A complete. Phase 5B is built and awaits proof on a real cluster; phases 6–15 await approval.

Each landed phase is verified rather than asserted. `bash scripts/verify-stack.sh` asserts its acceptance criteria
against a running stack — 36 checks covering every dependency, the migration state, security headers,
both languages, the licence offer, authentication actually refusing anonymous callers, setup being
closed once it has run, and the data tier not being reachable from the host. It runs in CI on every
change.

Two further harnesses cover what a stack-wide probe cannot. `scripts/verify-tenancy.sh` signs in as
two different people and tries to cross the tenant boundary through lists, filters, direct-id lookups
and writes — 34 checks. `scripts/verify-proxmox.sh` stands up a fixture Proxmox API with a real
certificate and drives the whole add-and-discover flow against it — 51 checks. `scripts/verify-jobs.sh`
drives the job system through cancellation, approvals and a killed worker — 44 checks — and
`scripts/verify-library.sh` moves real bytes through the ISO library, onto the fixture's storage and
back off it over SFTP — 73 checks. Each found real bugs the unit tests could not (ADR-030, ADR-031,
ADR-032, ADR-036, ADR-037).

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

## Phase 1 — Monorepo bootstrap and running stack · **L** · ✅ complete

pnpm workspaces, Turborepo, shared TS/ESLint/Prettier configs. NestJS api skeleton with
`/healthz`, `/readyz`, OpenAPI, global validation pipe, error filter, pino logging with redaction.
Next.js web skeleton with the sidebar shell, dark mode and server-side API reads (the proxy route was
dropped — see the Phase 1 amendment in tech-decisions.md ADR-003). Prisma package with the
initial migration (`system_settings` only). Redis + BullMQ wiring with a trivial ping job. Compose
files for dev and prod, Caddy, health checks, dependency ordering, named volumes. `.env.example`
with every variable documented. CI running lint, typecheck, test and build.

`packages/i18n` wired into web and api: `next-intl`, `en`/`nl` catalogues, locale switcher, and CI
validators for glossary integrity and locale key parity. AGPL §13 plumbing:
`GET /api/v1/system/source`, the About screen, `VELNOX_SOURCE_URL` and embedded build commit, plus a
CI dependency-licence check.

**Acceptance:** `docker compose up --build` on a clean machine brings up six healthy services;
`https://localhost` serves the shell; `/api/v1/health` responds through Caddy; a queued ping job is
processed by the worker and its completion is visible; `/api/docs` serves OpenAPI; switching to
Dutch changes every visible string; CI fails on a missing translation key or a malformed glossary
row; the About screen shows version, commit and a working source link.

## Phase 2 — Authentication, setup wizard, RBAC core · **XL** · ✅ complete

Argon2id hashing, JWT access + rotating refresh with reuse detection, CSRF double-submit, rate
limiting, secure headers. Setup wizard: `GET /setup/status`, `POST /setup/initialize` creating the
MSP root tenant, system roles and the first Super Administrator in one transaction, then permanently
closed. Permission catalogue, roles, role assignments, `RequestContext`, `@RequirePermission` guard
with scope resolution. Login/logout/refresh/me endpoints and UI. Audit events for auth actions.
Entra ID OIDC scaffolding: configuration model, discovery validation, "test connection", login
button behind a feature flag.

**MFA (optional, recommended):** TOTP enrolment with confirm-before-activate, Argon2id-hashed
single-use recovery codes shown once, `sessions.mfa_satisfied_at` enforced by a global guard, and the
`OPTIONAL` / `REQUIRED_FOR_PRIVILEGED` / `REQUIRED` policy at installation and tenant level. The
setup wizard and the users list actively recommend enrolment for privileged accounts.

**Acceptance:** a fresh install shows the wizard, refuses a weak password, creates exactly one
admin, and returns 409 on a second attempt; no default credentials exist anywhere; login/logout
work; an expired access token refreshes transparently; a replayed refresh token kills the session
family; a user without a permission gets 403 and the denial is audited; the permission matrix test
suite passes. MFA: enrolment cannot be completed without a valid code; a session that has not
satisfied a required policy can reach only enrolment and logout, verified against **every** existing
endpoint rather than a sample; a recovery code works exactly once and its use is audited and
alerted; the TOTP seed is stored via the credential store and appears in no API response, log or
audit record.

## Phase 3 — Multi-tenancy · **L** · ✅ complete

Tenants and sites CRUD. Prisma tenancy extension with the throw-on-missing-context rule and the
explicit `withSystemScope()` escape. Scope-aware role assignments (GLOBAL/TENANT/SITE/CLUSTER).
Tenant selector in the top bar (server-validated, never trusted from the client). Cross-tenant test
harness.

**Acceptance:** MSP root users see and manage all tenants; a tenant admin sees only their own and
cannot enumerate others; the isolation suite passes for read **and** write across every tenant-scoped
resource that exists at this point, including list endpoints, filters and direct-ID access;
querying a tenant-scoped model without a context throws in tests.

## Phase 4 — Proxmox integration and inventory · **XL** · ✅ complete

`packages/proxmox` with token and ticket auth, TLS fingerprint pinning, retries and the UPID task
poller. `packages/crypto` with envelope encryption and `DatabaseSecretStore`. Add cluster / add
standalone node flows including the fingerprint confirmation step. Discovery of cluster status,
quorum, nodes, versions, repositories, subscription, storage, network and workloads.
Inventory tables and UI: cluster list, node list with health/version/updates columns, node detail
page, VM/container inventory. Scheduled discovery via repeatable jobs.

**Ceph inventory** is part of this phase, not deferred to the upgrade work: `ceph_daemons` rows for
MON/MGR/OSD/MDS/RGW with version and state, PG counts, OSD up/in counts, MON quorum size, set flags
and version homogeneity. Ceph gets a UI surface (cluster detail tab) here, so the upgrade phases
build on inventory that is already proven against real clusters.

**Acceptance:** a real (or fixture-backed) cluster can be added with an API token; certificate
pinning is enforced and a mismatch fails closed; node and workload inventory populate and refresh on
schedule; PVE version and health are visible in the UI; credentials are stored encrypted and no
endpoint returns plaintext material; discovery of an unreachable node produces a recorded error, not
a silent success. Ceph: daemons, versions and PG state are discovered and displayed; a cluster with
`noout` left set is surfaced and alerted on; a non-Ceph cluster shows no Ceph surface at all rather
than empty tiles.

## Phase 5 — Job system · **L** · ✅ complete

Job state machine, `job_steps`, `job_events`, `job_logs`, approvals. SSE stream with Redis pub/sub.
Cancellation flags and `AbortSignal` plumbing. Crash reconciliation on worker start. Concurrency
keys. Jobs UI: list, filters, detail with live event stream, cancel, retry.

**Acceptance:** a long-running job streams progress live to the browser; cancelling stops it at the
next safe boundary and records `CANCELLED`; killing the worker mid-job leaves the job reconciled to
`FAILED` with `worker_lost`, not stuck in `RUNNING`; two mutating jobs against one cluster cannot run
concurrently; every invalid state transition throws.

## Phase 5A — Central ISO library · **XL** · ✅ complete

Requested by the owner on 2026-09-27, scheduled immediately after Phase 5 because every operation in
it is a multi-gigabyte transfer, which is what the job system exists to run.

A central store on the Velnox host for ISOs and — since Phase 5B settled on cloud images for Linux —
cloud disk images, with three movements: push an ISO to a cluster's storage,
pull one from a cluster into the library, and delete one from a cluster. Friendly names throughout —
`Windows11_25H2_Dutch` reads as "Windows 11 Version 25H2 Dutch" or "… Nederlands" depending on the
viewer's Velnox language — parsed from the filename with the operator able to correct it, because a
filename parser is a heuristic and a wrong confident label is worse than an honest raw one.

**As built** (ADR-037, ADR-038): an installation-wide library in its own volume with a size ceiling
and a free-disk floor; URL fetch with an SSRF guard, and resumable chunked browser upload; push
through Proxmox's upload call with the checksum verified on arrival; pull over **SFTP only**, set up
per cluster with host keys confirmed like a TLS fingerprint — chosen with the owner,
because Proxmox's API has no call that reads a file back; delete on the cluster; and an **ISOs &
images** tab per cluster. Proven against the fixture, not yet a real cluster — see
[Known gaps](known-gaps.md).

**Decisions taken with the owner before any of it was built:**

- **Both ways in.** Velnox fetches from a URL *and* accepts a browser upload. The URL path is the
  cheap one and shares its direction with the push; the upload path is the one that works on a
  network with no route out, and it is the one that costs: body limits in Caddy and Next, chunked
  transfer, and a resumable progress that survives a dropped connection.
- **Its own Docker volume with a hard ceiling.** Configurable, enforced with a refusal when full. The
  library must not be able to fill the disk PostgreSQL and Redis are on: a full disk there is not a
  failed upload, it is an installation that has stopped.
- **Its own phase rather than a feature squeezed into another.** It is also the first time Velnox
  *writes* to Proxmox. The worker already owns the only route to a node (ADR-009), so that is not an
  architectural change, but it is a first, and it deserves the ADR it will get.

**Acceptance:** an ISO reaches a node's storage and appears in Proxmox's own content list; the same
ISO pulled back into the library is byte-identical to what was pushed; deleting one on the cluster
removes it there and leaves the library copy alone; a transfer cancelled halfway leaves no partial
file on either side; filling the library is refused with the ceiling named, not with a disk error;
every screen shows friendly names and every log line shows the real filename.

## Phase 5B — Autoconfig templates and unattended VM provisioning · **XL** · built, not yet complete

**As built** (ADR-039, 0.5.9): templates owned by the MSP or a customer, offered, cloned and kept
private as below; every secret its own encrypted credential; VMs built by one job that copies the
media to the node, writes an Autounattend.xml or a cloud-init seed onto a small CD, waits for the
guest agent to report the install finished, and on failure destroys the VM; an audited reveal; mail
proven before it is switched on; an installation record encrypted with AES-256 revision 6.
`verify-provisioning.sh` proves 89 checks against the fixture. **Not marked complete** because the
acceptance below speaks of a guest installing without a keypress and of first-boot behaviour, and
the fixture installs nothing — see [Known gaps](known-gaps.md).

Requested by the owner on 2026-09-27. Scheduled after Phase 5 (jobs) and 5A (the ISO library),
because provisioning is a job and its first step is "is the ISO on that node".

**Autoconfig**, a tab under Administration, holds the templates. A template lives at MSP level or
tenant level; an MSP template is usable and clonable by every tenant beneath it unless it is marked
otherwise. Creating a VM then means picking a template, and Velnox: checks the ISO is on the target
node and uploads it if not, creates the VM, optionally starts it and lets the OS install itself,
notifies whoever asked when it finishes, and mails a PDF record of the installation.

### Windows — Autounattend.xml

The owner's seven fields: hostname without a domain; the edition to install (Home/Pro, or
Standard/Datacenter and their Desktop Experience variants); an optional product key, absent which the
VM asks for one at first boot exactly as it would unattended, or skips the question entirely where the
edition does not need one; regional and display-language settings; the local accounts to create with
their passwords and a per-account administrator flag, plus the built-in Administrator password which
Windows Server always requires; separate switches for QEMU Guest Agent and for VirtIO; and MBR or GPT
for the system disk, with GPT recommended everywhere it is offered.

Worth adding, and the reasons:

- **Four locale fields, not one.** Unattend distinguishes `UILanguage`, `SystemLocale`, `UserLocale`
  and `InputLocale`. Collapsing them is why a Dutch install so often ends up with a Dutch keyboard
  nobody wanted — Dutch operators overwhelmingly type on US-International.
- **Time zone**, which is not a locale and is the field that makes logs comparable across a fleet.
- **How the edition is actually chosen.** Unattend selects an image by `/IMAGE/INDEX` or
  `/IMAGE/NAME`, or is steered by a KMS client setup key. An edition dropdown that does not read the
  ISO's image list is a dropdown that silently installs the wrong edition.
- **OOBE screens to skip**, including the Microsoft-account requirement on Windows 11, and the privacy
  toggles — every one of which is a screen someone otherwise clicks through on a server.
- **Auto-logon count**, because installing the guest agent and VirtIO needs one logged-on pass. It
  must be set back afterwards; a VM left auto-logging on is a VM with no password.
- **First-logon commands**, which is where the agent and VirtIO installs actually run.
- **Workgroup name**, RDP and its firewall rule, the power plan, and whether hibernation stays.
- **Windows Update during OOBE or deferred** — the difference between a VM ready in ten minutes and
  one ready in an hour.

### Ubuntu and Debian

The owner's five: hostname; the version; regional and display-language settings; the root account and
optional extra root accounts; and the mirror, with Velnox recommending one.

**The mirror recommendation, stated rather than left to a benchmark:** for Debian, `deb.debian.org` —
the CDN, which resolves to something near the host and is never stale, and which beats a hand-picked
country mirror in almost every case. For Ubuntu, `mirror://mirrors.ubuntu.com/mirrors.txt`, which is
the official geo-selecting form. A Dutch installation that wants a fixed host can have
`nl.archive.ubuntu.com` or `ftp.nl.debian.org`, offered as a choice rather than as the default,
because a fixed mirror is a single point of failure the CDN does not have.

Worth adding: SSH authorised keys and whether password authentication is allowed at all;
`PermitRootLogin`; packages at first boot, `qemu-guest-agent` among them; time zone, locale and
keyboard as separate fields again; disk layout and swap; static addressing or DHCP; an APT proxy; and
unattended-upgrades.

**Settled with the owner on 2026-09-27:**

- **Linux provisions from cloud images, not from an installer ISO.** cloud-init does not drive an ISO
  install — Ubuntu's installer takes `autoinstall` and Debian's takes `preseed` — and the owner left
  the choice to the builder. Cloud images win on every axis that matters here: Proxmox supports them
  natively (`qm importdisk`, `--ciuser`, `--sshkeys`, `--ipconfig0`, `--cicustom`), a VM is usable in
  seconds rather than after an installer run, and the result is identical every time because nothing
  is answering prompts. The consequence for Phase 5A: **the library holds cloud images as well as
  ISOs**, and "is it on the node" means the disk image for Linux and the ISO for Windows. Windows
  stays ISO plus Autounattend.xml, because Microsoft ships no cloud image.
- **A sudo user with a key is the default; root login is an option, off unless chosen.** Extra
  accounts are sudo-capable users, not additional roots.
- **SSH access is a template switch**, on by default: `openssh-server` installed and enabled,
  authorised keys placed for each account, password authentication off unless the template turns it
  on, and — where the image ships a firewall — port 22 opened for it. Most cloud images already
  carry the server; the switch makes that a guarantee rather than an assumption about the image.

### Notification and the installation record

None of this exists yet: there is no mail transport, no notification system and no PDF generation in
the product. Phase 13 lists notifications as UI polish, which is not the same thing as delivery.
So this phase carries a first: SMTP configuration, a notification channel per recipient, and a PDF
renderer.

**The credentials in that PDF are the part to decide, not to implement quietly.** Velnox's own rules
say a password never appears in a log, never in job output, and never reaches the frontend unless an
explicit break-glass function requires it. A PDF of local administrator passwords, mailed, is a
durable copy of exactly that in a mailbox, on a relay, and in whatever backs both up — and ordinary
SMTP is not encrypted end to end.

**Settled with the owner:** the mail carries the installation record and **never the credentials in
the clear**. The credentials go one of two ways, chosen per template:

- **Only in Velnox** — the default. A link to the installation, where revealing the passwords is an
  audited action behind `clusters.manage` and the reveal expires.
- **An encrypted PDF** — AES-256, whose password is **not in the same mail**. It is shown once in
  Velnox to whoever started the provisioning, or set on the template by an administrator. A
  password-protected attachment with its password in the body is a plaintext attachment with extra
  steps.

**Acceptance:** an MSP template is visible to a tenant beneath it and a tenant template is not visible
upward; cloning an MSP template produces an independent copy; a template marked private is offered to
nobody else. Provisioning from a template puts the ISO on the node if it is missing, creates the VM
with the disk layout the template specifies, and the guest installs unattended without a keypress. A
Windows template with no product key produces a VM that asks for one; one with a key produces a VM
that does not. Passwords and product keys are stored with envelope encryption and appear in no log,
no job output, no API response and no mail body; an encrypted PDF's password never travels in the
mail that carries the PDF. A Linux VM with the SSH switch on accepts a key login on first boot and
refuses a password login unless the template allowed it. A failed install leaves no half-created VM. The installation record
names the hostname, the address, the duration and the template, and the notification arrives once.

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

**Composite plans:** `upgrade_plans.kind` with parent/child ordering, and `upgrade_targets` able to
address either a node or a Ceph daemon — the structural work that lets Phase 9A and 9B compose.

**Acceptance:** a playbook is defined as data and executed by the generic runner; remediation
metadata drives automatic-vs-approval routing; a composite plan sequences two child plans and stops
the parent when a child fails; reports render for both node-targeted and daemon-targeted runs. The
genericity claim is not asserted here — it is *proven* in 9A and 9B, which run two structurally
different workflows on this engine without changing it.

## Phase 9A — Ceph major upgrade workflow · **L**

The Ceph playbook: version-matrix data file validated against the live cluster at plan time;
repository stage; `noout` set/unset with guaranteed cleanup on failure and cancellation; daemon
ordering MON → MGR → OSD → MDS → RGW with health revalidation between every group and every node's
OSDs; `require-osd-release` raised only after all OSDs report the target release; homogeneity
verification. Standalone execution (upgrade Ceph only) as a first-class operation.

**Acceptance:** a plan refuses to build when the running release, the target and the matrix
disagree, naming which of the three is unexpected; the run refuses to start unless Ceph is
`HEALTH_OK` with all PGs active+clean and full MON quorum; daemons are restarted strictly in order,
one at a time, with health revalidated between each; an unrecognised `HEALTH_WARN` blocks rather than
continues; `noout` is unset on success, on failure **and** on cancellation, verified by a test that
kills the run mid-flight; a cluster already mid-upgrade (heterogeneous versions) is a blocker; the
report shows every daemon's version before and after.

## Phase 9B — PVE 8 → 9 workflow · **L**

The PVE playbook. `pve8to9` execution and versioned parser with golden-file tests over real output
from multiple point releases. Repository remediations (bookworm → trixie, deprecated repository
handling, enterprise/no-subscription), package remediations, storage and network blocker detection.
Canary-first node ordering with an explicit continue. Post-upgrade validation against PVE 9
expectations. Composition with 9A for Ceph-backed clusters.

**Acceptance:** preflight produces structured PASS/WARNING/BLOCKER/UNKNOWN with raw output retained;
unknown lines are treated as blockers and shown verbatim; a safe repository remediation applies,
validates and triggers an automatic re-check; an unsafe remediation halts for approval showing the
exact diff; blockers can never be bypassed by any UI action; the first node is a canary and the run
pauses for confirmation before the second; the report contains before/after node state. For a
Ceph-backed cluster, the composite plan runs the Ceph upgrade to completion **first** and refuses to
start the PVE upgrade if it did not.

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
Checksums, a manifest and a generated `THIRD-PARTY-NOTICES.md`. live-build ISO pipeline with an
honest preflight. **Air-gapped tar by default** (bundled `docker save` images) with a `--slim`
registry-pull variant.

**Acceptance:** a clean Debian 12 VM without Docker goes from `bash install.sh` to a working login page
in one command; re-running preserves `.env` and data; the tar.gz unpacks and installs on a second
host **with outbound network blocked**, given Docker is already present — and when Docker is absent
on an offline host the installer says so up front instead of failing halfway; `uninstall.sh` never
deletes volumes without explicit confirmation; every artifact ships checksums and third-party
notices; the ISO either builds and boots into an installer that produces a working appliance, or
fails with a clear message — never a placeholder file.

## Phase 15 — Security review, tests, documentation · **L**

Threat model, `docs/security.md`, dependency and container scanning, secure-header verification,
optional PostgreSQL RLS hardening, rate-limit tuning, backup/restore drill, key-rotation drill.
Complete the documentation set in English, synchronise `docs/nl/`, and sweep for hardcoded strings.
Fill test coverage gaps.

**Acceptance:** the full test suite passes in CI including tenant isolation, RBAC matrix, redaction,
quorum invariants and the Ceph `noout` cleanup guarantee; a documented restore-from-backup drill
succeeds on a fresh host; a master-key rotation drill succeeds; no user-visible string exists outside
the locale catalogues; every glossary term is used consistently; `docs/known-gaps.md` accurately
lists every remaining limitation.

---

## Delivery order rationale

Phases 2–3 come before any Proxmox work because tenancy and RBAC are boundaries that are painful to
retrofit — every later table and endpoint inherits them. Localization lands in Phase 1 for the same
reason: externalising strings is nearly free at the start and expensive at any later point.

Phase 5 (jobs) precedes updates and upgrades because both are jobs; building them first would mean
building the state machine twice. Phase 8 (generic framework) precedes 9A and 9B so genericity is
proven by construction — two structurally different workflows on one unchanged engine — rather than
claimed afterwards.

**9A (Ceph) before 9B (PVE 8→9)** follows the real-world constraint: a PVE major release ships a
specific Ceph release and does not support the previous one, so Ceph must be upgraded while the
cluster is still on its current PVE and Debian release. Building them in that order also means 9B
can compose 9A rather than the reverse.

The installer lands at Phase 14 because it packages whatever exists — but the compose stack from
Phase 1 is continuously runnable, so there is never a period where the product cannot be started.

## Cross-cutting work carried in every phase

Audit events for every new mutating action; OpenAPI kept current; tenancy and permission tests
alongside each new resource; **every new user-visible string added to `en.json` and `nl.json` in the
same commit**; `.env.example` updated with any new variable; `docs/known-gaps.md` updated when
something ships incomplete.

**Marking a phase complete is what moves the version.** The `✅ complete` marker on the headings
above is read by `scripts/version.mjs`: below 1.0.0 the minor number is the phase number, so
finishing Phase N is what makes the product `0.N.0`. `pnpm run validate:version` fails when the two
disagree, and `version:phase` refuses to run ahead of this file. Mark it here, in the change that
finishes the phase.

**Operator documentation, in the same phase that ships the feature.** Every phase that adds
something an operator does adds the how-to for it, in English and Dutch, to the guides that ship
inside the product — not to a backlog. A phase is not finished while the only way to learn how to
use what it built is to read its source. The guides are task-shaped (*creating a cluster*, *adding a
node*) and separate from the reference documents, which explain how the system is put together; see
ADR-026 in [tech-decisions.md](tech-decisions.md).

| Phase | Guide it must produce |
|---|---|
| 3 | Creating a customer tenant; adding a site; scoping a grant below global |
| 4 | Adding a cluster; adding a node; storing infrastructure credentials; reading inventory |
| 5 | Watching, cancelling and approving jobs |
| 6 | Reviewing and applying updates |
| 7–9 | Running a rolling update; running a major upgrade; the Ceph and PVE 8 → 9 workflows |
| 10 | Setting a rotation policy; break-glass reveal |
| 11–12 | Assessing and running a VMware or Hyper-V migration |

---

*The Velnox name and logo are used by The Velnox Foundation. No trademark is registered or claimed; the AGPLv3 grants no rights in either.*

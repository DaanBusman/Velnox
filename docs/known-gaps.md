# Velnox — Known Gaps

This file is the honest ledger. Anything Velnox does not do, does not do fully, or does in an
operator-assisted way is written here — and is never presented in the UI as working.

It is updated in **every** phase. A phase that ships something incomplete without an entry here has
not met its gate.

---

## Current status: Phase 4 (multi-tenancy, Proxmox inventory)

Sign-in works. The setup wizard creates the first administrator and then closes permanently. Every
API endpoint that is not deliberately public requires a session, and the global guard is
protect-by-default: a new endpoint is protected by existing, and has to opt out in writing.

Customers are real: tenants, sites, and grants that name what they cover, with the isolation applied
in the data layer rather than remembered by each endpoint. Proxmox clusters can be added against a
confirmed certificate fingerprint, and their nodes, guests, storage, networks and Ceph are
inventoried on a schedule.

**Velnox is read-only against your infrastructure in this phase.** Nothing starts, stops, migrates,
updates or reconfigures anything.

What is **not** there yet, in order of how much it matters:

### Signing in with Microsoft Entra ID does not work yet
The configuration model, discovery validation and "test connection" are real: the API fetches the
provider's discovery document, validates it, and records what it observed. The authorization code +
PKCE flow that would actually sign someone in is not written. `signInAvailable` in the API response
says `false`, the sign-in page shows no Microsoft button, and the settings page says so in as many
words. Nothing here pretends to work.

### Roles are seeded, not editable
The seven system roles are created at setup from the frozen catalogue in `packages/shared`, and the
Roles & Permissions page shows exactly what each one grants. There is no interface for creating a
custom role or changing which permissions a role holds — that arrives with multi-tenancy, where a
tenant-defined role first has something to scope to.

### There is no self-service password change
An administrator sets an account's initial password and passes it on out of band, because Velnox
sends no email. The account cannot then change it from the interface: `changePassword` exists in the
service, enforces the strength rule and revokes every other session, but has no endpoint yet.

### Recovery-code use is logged, not alerted
Using a recovery code is written to the audit trail and emitted as a `warn`-level event with a
stable name (`auth.mfa.recovery_code_used`), which an operator's log pipeline can alert on today.
Velnox has no alert delivery of its own yet — no email, no webhook — so the roadmap's word
"alerted" is currently satisfied by the log, not by Velnox contacting anyone.

### The SSRF guard on discovery has a DNS-rebinding gap
Before fetching a discovery document the API requires HTTPS, refuses redirects, and resolves the
hostname to check it is not a private, loopback, link-local or cloud-metadata address. A name that
resolves differently between that check and the fetch would slip past. Closing it properly needs an
agent pinned to the checked address. The endpoint is restricted to `system.manage`, which is the
highest permission the product has, and the check stops every straightforward attempt — including
`169.254.169.254` and internal container names, both verified.

### There is no session list, and no "sign out everywhere"
Sessions rotate correctly and a replayed refresh token revokes the family, but a user cannot see
their active sessions or end them from the interface. Changing a password already revokes every
session as a side effect.

### The backend image carries its build dependencies
`deploy/docker/backend.Dockerfile` copies the whole workspace, including devDependencies, into the
runtime layer. pnpm's `node_modules` is a graph of relative symlinks that does not survive being
taken apart, and a naive `pnpm prune --prod` would delete the generated Prisma client. Producing a
properly slimmed runtime image is Phase 14 packaging work, and it matters there because it is part
of the ~1 GB air-gapped artifact budget.

### The Content-Security-Policy still allows `'unsafe-inline'`
Next.js emits inline bootstrap scripts and inline styles, and Swagger UI at `/api/docs` does the
same. Replacing that with per-request nonces is Phase 15 hardening. The header is present and every
other security header is strict; this one specific relaxation is real and is not being papered over.

### Standalone output is opt-in, for a Windows reason
`next build` only emits `output: 'standalone'` when `VELNOX_STANDALONE=1`, which the Dockerfile
sets. Tracing creates symlinks, and Windows refuses that without Developer Mode — leaving it always
on would mean a developer on Windows could not build the app at all. The shipped image is always
the standalone one.

### The dashboard counters are dashes, not zeros
Tenants, clusters, nodes and the rest show `—` with the phase that will populate them. They are not
placeholders for hidden data and they are not zeroes pretending to be measurements. The one card
backed by real data is service status, and it is live.

### Alerts have no lifecycle
The alerts screen shows conditions computed from the inventory each time it is opened. That is the
whole of it: there is no acknowledgement, no silencing, no history and no notification — no email, no
webhook, nothing that reaches you when you are not looking at the screen.

Deliberate, and the smaller half of the problem on purpose. A stored alert needs raised /
acknowledged / resolved / re-raised, and a half-built lifecycle produces a screen full of stale
alarms nobody reads, which is worse than a screen that is honest about only knowing what is true now.
The scheduler that would deliver them arrives with the job system.

### Nothing reaches a node over SSH yet
Everything in Phase 4 goes through the Proxmox API. `credentials` has `SSH_PASSWORD` and `SSH_KEY`
kinds and `nodes` reserves a host-key fingerprint, because credential rotation (Phase 10) needs a
shell — but no SSH client ships in this build and no screen offers to store one.

### Update counts are counts, not classifications
A node reports how many packages apt would install. Which of them are security updates, which need a
reboot, and which are Proxmox's own is Phase 6's work, and the interface says only the number it
actually has rather than colouring it in.

### Discovery is polled, not pushed
Proxmox has no event stream Velnox can subscribe to, so inventory is as fresh as the last run — 30
minutes by default. The interface treats that as a fact rather than hiding it: *last read* is a
column on every cluster, and a failed run leaves the previous inventory in place rather than blanking
it.

### One credential per cluster
A cluster carries a single API token or password, used for every node. Per-node credentials are
modelled in the schema and not offered: no operator has asked for them, and the flow for confirming
fifteen fingerprints one at a time needs designing before it is built.

### The job system is a queue, not a job system
Adding a cluster waits on a worker job through a request-scoped timeout, and discovery runs are
recorded in their own table rather than in the general job model. Progress does not stream, a run
cannot be cancelled, and a worker killed mid-discovery leaves a run row marked `RUNNING` for ever.
Phase 5 replaces all three.

### Documentation drift is now possible
Phase 1 amended two Phase 0 decisions (see *Amended in Phase 1* in `architecture.md` and
`tech-decisions.md`). The Dutch translations under `docs/nl/` record the English commit they were
translated from; `scripts/check-doc-sync.mjs` reports which ones have fallen behind. It warns, it
does not block.

### Resolved in Phase 4
- **The Users tenant filter had one option to choose from.** There are customer tenants now, the
  filter narrows to them, and the same control sits in the top bar and follows you between pages.
- **The dashboard counters are dashes, not zeros** — still true of the dashboard itself, which is
  Phase 13's work, but the inventory screens behind it are real.
- **Tenant isolation was a rule each endpoint remembered.** It is a data-layer filter now, and a
  query with no scope resolved throws rather than returning everything (ADR-030).

### Resolved in Phase 2
- **There is no authentication.** There is now. Every non-public endpoint requires a session, and
  `scripts/verify-stack.sh` asserts that anonymous callers are refused.
- **`VELNOX_DEV_ENDPOINTS` exposes a diagnostic endpoint.** The endpoint, the flag and the dashboard
  card that called it are all gone. The acceptance script's check for it had quietly become a
  permanent skip; it has been replaced with checks that assert authentication is enforced.
- **Users can be listed, not managed.** Accounts can now be created, disabled and re-enabled, and
  roles granted and taken away — each one audited. Disabling revokes the account's sessions
  immediately rather than letting them run until their tokens expire.
- **The audit log has no interface.** There is one, paged by cursor, filtered by the reader's own
  tenant and permission.
- **An expired access token does not refresh transparently.** It does now. An open tab refreshes
  itself before the fifteen minutes are up, and a page loaded with a stale token asks the browser to
  exchange the refresh cookie rather than redirecting to the sign-in form. Verified by invalidating
  a live access token and reloading: the page came back without asking anyone to sign in again.

---

## Deliberate v1 scope exclusions

These are decisions, not omissions. They are out of scope unless the product owner says otherwise.

| Area | Excluded | Reason |
|---|---|---|
| Metrics | Long-term time-series storage and graphing | Velnox records point-in-time inventory and health; a TSDB is a different product. Future: Prometheus integration. |
| Backups | Managing or storing VM backups | Proxmox Backup Server does this. Velnox may orchestrate PBS later; it will never store VM data. |
| PBS | Proxmox Backup Server as first-class inventory | **Deferred by decision (2026-08-31).** The upgrade framework accepts a PBS playbook, and `upgrade_plans.kind` already has a `PBS` value, but no PBS inventory or playbook ships in v1. |
| Agent | Any software installed on managed nodes | Velnox is agentless. This costs resilience against dropped SSH sessions (R-16) and is a conscious trade. |
| Portal | Customer-facing self-service | Tenant users in v1 are operators, not end customers. |
| Rollback | Rolling back a completed Debian major upgrade | Technically not reliably possible. Velnox states this before the operator confirms and requires a documented backup as a precondition. |

---

## Anticipated partial implementations (to be confirmed as each phase lands)

These are flagged now so nobody is surprised later. Each will be revisited and made precise in its
own phase.

### Hyper-V disk transfer — *operator-assisted* (Phase 12)
Discovery, compatibility assessment and planning are automated. The VHDX transfer step requires
network paths (SMB or SSH from the appliance to the Hyper-V host or its storage) that many
environments will not grant. In v1 this step is labelled operator-assisted in the UI and reports
success only after Velnox verifies the resulting file — it never marks itself complete on its own.

### VMware transfer — *depends on target PVE version* (Phase 11)
Velnox orchestrates Proxmox VE's native ESXi import storage, available from PVE 8.2. On older
clusters, Velnox delivers discovery, compatibility assessment and a documented manual procedure —
and says so in the UI rather than offering a control that cannot work.

### ISO build — *Linux host only* (Phase 14)
`live-build` needs loop devices and elevated privileges. ISO building does not work on Docker
Desktop for Windows or macOS. `build.sh --target iso` preflights and fails with a clear message
rather than producing a non-bootable placeholder. The tar.gz and self-extracting installer targets
have no such constraint.

### PostgreSQL Row-Level Security — *deferred to Phase 15*
Tenant isolation in Phases 3–14 is enforced by the Prisma tenancy extension plus RBAC guards plus
CI-blocking cross-tenant tests. RLS is a fourth layer, deferred because it forces every query into
an explicit transaction. Recorded here rather than quietly skipped.

### Secret store backends — *database only in v1*
`SecretStore` is an interface with `put`/`get`/`delete`/`rewrap`. Only `DatabaseSecretStore` ships.
HashiCorp Vault and Azure Key Vault backends are designed for but not implemented, which means
`MASTER_ENCRYPTION_KEY` is a single point of failure (R-05).

### Multi-factor authentication — *TOTP only; WebAuthn deferred*
**Now in scope (2026-08-31): optional but recommended.** TOTP with recovery codes ships in Phase 2,
with `OPTIONAL` / `REQUIRED_FOR_PRIVILEGED` / `REQUIRED` policies and `OPTIONAL` as the default.
WebAuthn/passkeys are **not** implemented — `user_mfa_factors.kind` reserves the value. TOTP was
chosen first because it is the factor that still works for a break-glass account on an unexpected
machine during an incident.

### Ceph — *upgrades in scope; automated repair is not*
**Now in scope (2026-08-31):** Ceph inventory (Phase 4) and Ceph major-version upgrades as their own
playbook composed before the PVE upgrade (Phase 9A). What Velnox does **not** do: repair a damaged
Ceph cluster. If health does not return, the run stops and reports — it does not attempt automated
recovery, because that is expert work where a wrong automated action makes things worse.

### Dutch documentation — *translation drift is possible*
English under `docs/` is canonical; `docs/nl/` is a translation. CI *warns* when an English source
has changed since its Dutch counterpart was translated, but does not block — English documentation is
never held hostage to a pending translation. So a Dutch document can be behind. Each one records the
source commit it was translated from, so a reader can tell. UI strings are held to a stricter rule:
a missing or extra locale key **fails** the build.

### AGPL §13 source offer — *depends on the operator*
Velnox ships the mechanism (`GET /api/v1/system/source`, Settings → About, `VELNOX_SOURCE_URL`,
embedded build commit). An operator running a **modified** build must point that variable at their
own Corresponding Source. Velnox cannot verify that they did — no software can. The obligation is
theirs; the mechanism is ours.

### Sub-tenants — *schema-ready, not implemented*
`tenants.parent_tenant_id` exists so hierarchical tenants remain possible, but v1 supports exactly
one level of customer tenants beneath the MSP root.

---

*The Velnox name and logo are used by The Velnox Foundation. No trademark is registered or claimed; the AGPLv3 grants no rights in either.*

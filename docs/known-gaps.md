# Velnox — Known Gaps

This file is the honest ledger. Anything Velnox does not do, does not do fully, or does in an
operator-assisted way is written here — and is never presented in the UI as working.

It is updated in **every** phase. A phase that ships something incomplete without an entry here has
not met its gate.

---

## Current status: Phase 1 (foundation)

The stack runs: six services, database, queue, localization, licence compliance. What is **not**
there yet, in order of how much it matters:

### There is no authentication. At all.
Every endpoint is unauthenticated and every page is public. Authentication, RBAC and multi-tenancy
arrive in Phase 2 and 3. **Do not put a Phase 1 build on a network you do not fully control.** The
API says so on startup, and the dashboard says so to anyone who opens it.

### `VELNOX_DEV_ENDPOINTS` exposes a diagnostic endpoint
The queue self-test (`POST /api/v1/system/selftest/queue`) exists to demonstrate that the worker
executes submitted work. It touches no managed infrastructure and returns nothing sensitive, but it
is unauthenticated like everything else in this build. It defaults to off in `.env.example`; the
flag and the endpoint are both removed in Phase 2.

### The backend image carries its build dependencies
`deploy/docker/backend.Dockerfile` copies the whole workspace, including devDependencies, into the
runtime layer. pnpm's `node_modules` is a graph of relative symlinks that does not survive being
taken apart, and a naive `pnpm prune --prod` would delete the generated Prisma client. Producing a
properly slimmed runtime image is Phase 14 packaging work, and it matters there because it is part
of the ~1 GB air-gapped artifact budget.

### The Content-Security-Policy still allows `'unsafe-inline'`
Next.js emits inline bootstrap scripts and inline styles, and Swagger UI does the same. Replacing
that with per-request nonces is Phase 15 hardening. The header is present and every other security
header is strict; this one specific relaxation is real and is not being papered over.

### Standalone output is opt-in, for a Windows reason
`next build` only emits `output: 'standalone'` when `VELNOX_STANDALONE=1`, which the Dockerfile
sets. Tracing creates symlinks, and Windows refuses that without Developer Mode — leaving it always
on would mean a developer on Windows could not build the app at all. The shipped image is always
the standalone one.

### The dashboard counters are dashes, not zeros
Tenants, clusters, nodes and the rest show `—` with the phase that will populate them. They are not
placeholders for hidden data and they are not zeroes pretending to be measurements. The one card
backed by real data is service status, and it is live.

### Documentation drift is now possible
Phase 1 amended two Phase 0 decisions (see *Amended in Phase 1* in `architecture.md` and
`tech-decisions.md`). The Dutch translations under `docs/nl/` record the English commit they were
translated from; `scripts/check-doc-sync.mjs` reports which ones have fallen behind. It warns, it
does not block.

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

*Velnox™ is a trademark of The Velnox Foundation.*

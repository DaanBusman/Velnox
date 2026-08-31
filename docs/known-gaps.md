# Velnox — Known Gaps

This file is the honest ledger. Anything Velnox does not do, does not do fully, or does in an
operator-assisted way is written here — and is never presented in the UI as working.

It is updated in **every** phase. A phase that ships something incomplete without an entry here has
not met its gate.

---

## Current status: Phase 0 (design only)

**Everything is a gap.** No application code exists. The repository contains architecture documents
only. Nothing can be installed, started or used.

---

## Deliberate v1 scope exclusions

These are decisions, not omissions. They are out of scope unless the product owner says otherwise.

| Area | Excluded | Reason |
|---|---|---|
| Metrics | Long-term time-series storage and graphing | Velnox records point-in-time inventory and health; a TSDB is a different product. Future: Prometheus integration. |
| Backups | Managing or storing VM backups | Proxmox Backup Server does this. Velnox may orchestrate PBS later; it will never store VM data. |
| Ceph | Ceph major-version upgrades | The upgrade framework is built to accept a Ceph playbook, but none ships in v1. Ceph health is monitored and guarded on. See open question 1 in [risks.md](risks.md). |
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

### Multi-factor authentication — *not in v1 scope*
The user model reserves `mfa_enrolled`, but no TOTP or WebAuthn flow is planned for v1. Entra ID SSO
can supply MFA for SSO users; local break-glass accounts would not have it. Flagged because it is a
reasonable thing to expect from a tool holding hypervisor root credentials — raise it if it should
move into scope.

### Sub-tenants — *schema-ready, not implemented*
`tenants.parent_tenant_id` exists so hierarchical tenants remain possible, but v1 supports exactly
one level of customer tenants beneath the MSP root.

---

*Velnox™ is a trademark of The Velnox Foundation.*

# Roles and permissions

**The complete specification of what every role grants.** This is the reference; the
**Roles & permissions** screen in Velnox shows the roles as they exist in *your* database, which is
the same thing on a fresh installation and may differ once roles become editable.

For the tasks — granting a role, taking one away, disabling an account — see
[Managing users and access](managing-access.md).

---

## How permissions work

A permission is a single verb on a single kind of resource, named `resource.action`:

- **`read`** sees.
- **`manage`** creates, changes and deletes.
- **`execute`** starts work against real infrastructure.

The split between `manage` and `execute` is deliberate. Planning an upgrade and running one against
a customer's production cluster are different levels of trust, and a role can hold the first without
the second.

Permissions are not granted to people. They are granted to **roles**, and roles are granted to
accounts. There is no way to give one account one extra permission — deliberately, because a
permission set assembled per person is a permission set nobody can review.

The catalogue is a frozen list in the source code. A permission that is not in it does not exist:
adding one is a code change plus a data migration, never a runtime data-entry screen, so the set of
things a role can be granted is always visible in a diff.

---

## Scopes

Every grant carries a scope, and covers that scope and everything beneath it:

```
GLOBAL  →  TENANT  →  SITE  →  CLUSTER
```

A grant at `TENANT` covers every site, cluster and node in that tenant. A grant at `CLUSTER` covers
that cluster alone.

**`GLOBAL` is only assignable to members of the MSP root tenant** — your own organisation. A
customer's administrator cannot hold a global grant, no matter which role they are given.

Until multi-tenancy lands in phase 3 there is one tenant, so in practice every grant today is global
and the scopes below it have nothing to point at yet.

---

## The seven system roles

Seeded by the setup wizard. **MSP only** roles can be granted only to accounts in your own
organisation.

| Role | Key | MSP only | Grants | For |
|---|---|:-:|--:|---|
| MSP Super Administrator | `msp_super_administrator` | yes | 36 of 36 | The first administrator. The only role with installation-wide settings. |
| MSP Administrator | `msp_administrator` | yes | 34 | Runs the MSP day to day, including people. Not installation settings, and not a colleague’s second factor. |
| MSP Engineer | `msp_engineer` | yes | 28 | Runs the fleet, and can reset a customer’s second factor. No identity administration, no audit log. |
| MSP Read Only | `msp_read_only` | yes | 18 | Sees everything across all tenants, changes nothing. |
| Tenant Administrator | `tenant_administrator` | no | 32 | Full control within one tenant, including that tenant's own people. |
| Tenant Operator | `tenant_operator` | no | 22 | Day-to-day work on one tenant's resources. No identity administration. |
| Tenant Read Only | `tenant_read_only` | no | 17 | Sees one tenant's resources, changes nothing. |

The two differences that surprise people:

- **MSP Administrator differs from MSP Super Administrator by exactly two permissions:**
  `system.manage`, and `users.reset_mfa_msp` — removing the second factor from a colleague.
  Everything else — every tenant, every user, every role — is the same.
- **MSP Engineer cannot read the audit log.** Operating the fleet and reviewing who did what are
  separate jobs, and the audit log is where the engineer's own actions are recorded.

---

## The full matrix

Every permission against every role. Column headings, in order: MSP Super Administrator, MSP
Administrator, MSP Engineer, MSP Read Only, Tenant Administrator, Tenant Operator, Tenant Read Only.

| Permission | Super | Admin | Eng | RO | T-Admin | T-Op | T-RO |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `tenants.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `tenants.manage` | ✓ | ✓ | · | · | · | · | · |
| `sites.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `sites.manage` | ✓ | ✓ | · | · | ✓ | · | · |
| `users.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `users.manage` | ✓ | ✓ | · | · | ✓ | · | · |
| `users.reset_mfa` | ✓ | ✓ | ✓ | · | · | · | · |
| `users.reset_mfa_msp` | ✓ | · | · | · | · | · | · |
| `roles.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `roles.manage` | ✓ | ✓ | · | · | ✓ | · | · |
| `clusters.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `clusters.manage` | ✓ | ✓ | ✓ | · | ✓ | ✓ | · |
| `nodes.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `nodes.manage` | ✓ | ✓ | ✓ | · | ✓ | ✓ | · |
| `workloads.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `storage.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `networks.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `updates.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `updates.execute` | ✓ | ✓ | ✓ | · | ✓ | ✓ | · |
| `upgrades.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `upgrades.execute` | ✓ | ✓ | ✓ | · | ✓ | · | · |
| `automation.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `automation.manage` | ✓ | ✓ | ✓ | · | ✓ | · | · |
| `credentials.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `credentials.manage` | ✓ | ✓ | ✓ | · | ✓ | · | · |
| `credentials.rotate` | ✓ | ✓ | ✓ | · | ✓ | · | · |
| `migrations.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `migrations.execute` | ✓ | ✓ | ✓ | · | ✓ | · | · |
| `jobs.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `jobs.cancel` | ✓ | ✓ | ✓ | · | ✓ | ✓ | · |
| `jobs.approve` | ✓ | ✓ | · | · | ✓ | · | · |
| `alerts.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `alerts.manage` | ✓ | ✓ | ✓ | · | ✓ | ✓ | · |
| `reports.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `audit.read` | ✓ | ✓ | · | ✓ | ✓ | · | · |
| `system.manage` | ✓ | · | · | · | · | · | · |

A test compares this table against the catalogue in the source on every run. If the two disagree,
the build fails rather than shipping a reference that is quietly wrong.

---

## What each permission allows

The phase column is honest about which permissions govern something that exists in this build and
which are reserved for the feature that will need them. A permission with a future phase can be
granted today and guards nothing yet.

| Permission | Allows | Live from |
|---|---|:-:|
| `tenants.read` | See customer organisations | 3 |
| `tenants.manage` | Create, rename and archive customer organisations | 3 |
| `sites.read` | See physical or logical locations within a tenant | 3 |
| `sites.manage` | Create and change sites | 3 |
| `users.read` | See accounts, their roles and their two-factor status | **2** |
| `users.manage` | Create accounts, enable and disable them | **2** |
| `users.reset_mfa` | Remove the second factor from an account in a **customer** tenant | **2** |
| `users.reset_mfa_msp` | The same for an account in the **MSP root** tenant. Required in addition to `users.reset_mfa` | **2** |
| `roles.read` | See roles and what they grant | **2** |
| `roles.manage` | Grant and revoke roles | **2** |
| `clusters.read` | See Proxmox clusters and their health | 4 |
| `clusters.manage` | Add, configure and remove clusters | 4 |
| `nodes.read` | See nodes, their versions and their state | 4 |
| `nodes.manage` | Add, configure and remove nodes | 4 |
| `workloads.read` | See virtual machines and containers | 4 |
| `storage.read` | See storage pools and their usage | 4 |
| `networks.read` | See bridges, VLANs and network configuration | 4 |
| `updates.read` | See available package updates | 6 |
| `updates.execute` | Apply updates to real nodes | 6 |
| `upgrades.read` | See major-upgrade plans and readiness | 8 |
| `upgrades.execute` | Run a major upgrade against real infrastructure | 8 |
| `automation.read` | See schedules and automation rules | 8 |
| `automation.manage` | Create and change schedules and automation rules | 8 |
| `credentials.read` | See that a credential exists, and its metadata | 4 |
| `credentials.manage` | Store, replace and remove credentials | 4 |
| `credentials.rotate` | Rotate a credential on the target system | 10 |
| `migrations.read` | See migration plans and assessments | 11 |
| `migrations.execute` | Run a migration | 11 |
| `jobs.read` | See queued, running and finished jobs | 5 |
| `jobs.cancel` | Cancel a running job | 5 |
| `jobs.approve` | Approve a job that is waiting on a human | 5 |
| `alerts.read` | See alerts | 4 |
| `alerts.manage` | Acknowledge and resolve alerts | 4 |
| `reports.read` | See and export reports | 8 |
| `audit.read` | Read the audit log | **2** |
| `system.manage` | Change installation-wide settings, including single sign-on | **2** |

**`credentials.read` does not read secret material.** It sees that a credential exists, what it is
for and when it was last rotated. No permission grants reading the secret itself, because no
endpoint returns it — infrastructure credentials are decrypted only inside the worker, at the moment
they are used. See [Technical decisions](tech-decisions.md), ADR-009 and ADR-023.

---

## Privileged permissions and two-factor authentication

These sixteen permissions let a principal change customer infrastructure or the security posture of
the installation. They are what the `REQUIRED_FOR_PRIVILEGED` two-factor policy resolves to:

`tenants.manage` · `sites.manage` · `users.manage` · `users.reset_mfa` · `users.reset_mfa_msp` ·
`roles.manage` · `clusters.manage` · `nodes.manage` · `updates.execute` · `upgrades.execute` ·
`automation.manage` · `credentials.manage` · `credentials.rotate` · `migrations.execute` ·
`jobs.approve` · `system.manage`

It is an explicit list rather than "everything ending in `.manage`", because the two are not the
same. **`alerts.manage` is deliberately absent:** acknowledging and resolving alerts changes
Velnox's own view of the world, not a customer's hypervisor. Suppressing an alert can hide an
incident, which is worth auditing — but it is not worth forcing a second factor over.

Under this policy, five of the seven roles require a second factor. Only **MSP Read Only** and
**Tenant Read Only** never do, because they hold nothing but `.read` permissions. Tenant Operator
does require one — it holds `clusters.manage`, `nodes.manage` and `updates.execute`, which reach a
customer's hypervisor.

The Users screen names privileged accounts that have not enrolled, regardless of which policy is in
force, so the exposure is visible before you decide to close it.

---

## Changing what a role grants

Not in this build. The seven system roles are seeded and read-only; there is no screen for creating
a role or editing one, and that is recorded in [Known gaps](known-gaps.md) rather than implied by
the presence of a page that lists them.

The **Roles & permissions** screen reads from your database rather than from the catalogue, so it
stays correct once editing arrives. If it ever shows a permission this build does not recognise, it
says so — that means the database and the code disagree, which is worth seeing rather than hiding.

---

## Where to go next

- [Managing users and access](managing-access.md) — how to grant, revoke and disable
- [Getting started](getting-started.md) — the first hour after installing
- [Technical decisions](tech-decisions.md) — why the catalogue is frozen, and what that costs
- [Architecture](architecture.md) — where the permission check actually happens

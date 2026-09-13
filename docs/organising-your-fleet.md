# Organising your fleet: tenants and sites

**Everything about dividing the installation up by customer and by location.** Each section is one
task, written to be read while doing it.

For accounts, roles and sign-in, see [Managing users and access](managing-access.md). For what each
role grants, see [Roles and permissions](permissions.md).

---

## What a tenant is

A **tenant** is one customer organisation. Every account, site, credential and — from phase 4 —
every cluster belongs to exactly one.

There is always one special tenant: **your own MSP organisation**, created by the setup wizard. It
is marked `MSP` everywhere it appears. Accounts in it are the ones that can reach across customers;
accounts in a customer's tenant can only ever see that customer.

That boundary is not a filter on a screen. It is applied in the data layer, underneath every query
the software makes, and a request that arrives without a resolved tenant scope is refused rather
than answered with everything. Practically, this means you cannot misconfigure your way into showing
one customer another customer's infrastructure — the interface has no setting for it, and neither
does the API.

**A tenant is not a folder.** Moving things between tenants is deliberately not possible. A site
belongs to the tenant it was created in, for its whole life, because moving one would silently move
every permission scoped to it.

---

## Create a customer tenant

You need `tenants.manage` **at global scope** — in practice, MSP Super Administrator or MSP
Administrator. A grant covering one customer does not let you create another, and the refusal says
so.

1. Go to **Tenants**.
2. **Add tenant**.
3. Give it the customer's name, the way you would write it on an invoice. The short identifier used
   in URLs is derived from it automatically; if two customers have the same name, the second gets a
   number appended rather than being refused.
4. **Add tenant**.

The tenant appears immediately with no accounts and no sites. Nobody can sign in to it until you
create an account there — see *Add an account* in
[Managing users and access](managing-access.md), which now lets you choose the tenant.

### Require two-factor authentication for one customer

Each tenant carries its own multi-factor policy, and the effective policy for an account is **the
stricter of the installation's and its tenant's**. A customer whose contract demands it can be set
to `Required for everyone` without changing anything for anyone else, and the installation-wide
setting can never be loosened by a tenant.

Open the tenant's **Details** and change **Second factor**.

---

## Add a site

A **site** is a location inside a tenant: a datacentre, an office, a rack in a colocation. Two
things need them:

- a permission can be scoped to one site rather than to the whole customer;
- from phase 4, a cluster belongs to a site, which is what makes "everything in Amsterdam" a
  question the software can answer.

You need `sites.manage` covering that tenant.

1. Go to **Sites**.
2. **Add site**.
3. Choose the **tenant**. This is the only moment you can: it is fixed once the site exists.
4. Name it, and optionally record where it is and who to call about it. The contact is a note for
   whoever reads it during an incident — Velnox sends no mail and will not use it.
5. **Add site**.

### Removing one

A site can be removed once nothing points at it. If any permission is scoped to it, the removal is
refused and the screen says how many — revoke those first. The reason is worth knowing: the scope of
a permission is stored as a plain identifier, so a deleted site would leave permissions that look
granted and cover nothing at all. A permission that silently became inert is worse than one that was
never given, because nobody goes looking for it.

Removing a site hides it. Anything recorded against it in the audit log stays readable.

---

## Scope a permission below "everything"

This is the part that changes how you work once you have more than one customer.

A grant has two halves: **which role**, and **what it covers**. Before phase 3 there was only one
answer to the second — everything — which was honest on an installation with one tenant and wrong on
one with fifty.

The scopes, widest first:

| Scope | Covers | Who can hold it |
|---|---|---|
| **Every tenant** | The whole installation | Only accounts in the MSP organisation |
| **Tenant** | One customer, and every site and cluster beneath it | Anyone |
| **Site** | One location, and every cluster in it | Anyone |

To grant one:

1. Go to **Users** and open the account's row.
2. Under **Grant role**, choose the role and then choose **Covering**.
3. **Grant**.

The account's roles are then listed with their scope beside them, because "MSP Engineer" on its own
tells you nothing useful once a grant can be narrower than everything — the interesting half is
which customer it reaches.

### What you can and cannot grant

- **You cannot grant what you do not hold.** Granting a role covering a customer requires
  `roles.manage` covering that same customer. This is the rule that stops delegation from being a
  way to widen access: an administrator given one customer can hand that customer out and nothing
  more.
- **A customer's account stays inside its own tenant.** Granting someone in Contoso a scope in
  Northwind is refused. Only accounts in the MSP organisation may hold a grant pointing at somebody
  else's tenant — that is what managing other people's infrastructure means.
- **"Every tenant" needs a home in the MSP organisation.** The database refuses it for anyone else,
  and the option is not offered.

### A worked example

You have taken on an engineer who looks after one customer's Amsterdam datacentre and nothing else.

1. Create their account in **your MSP organisation** — they are your employee, not the customer's.
2. Grant them **MSP Engineer**, covering **Site: Amsterdam (Contoso Cloud)**.

They can now see and work on that site. Contoso's other locations, and every other customer, are not
merely hidden from them — the API refuses the request and the data layer would filter it out even if
it did not.

---

## Suspend or archive a customer

**Suspending** a tenant is a pause. **Archiving** is how a customer stops appearing.

Neither deletes anything. Velnox has no way to erase a customer's history from the interface, and
that is deliberate: an audit trail with a hole in it is worse than no audit trail, and "we no longer
work with this customer" is not the same statement as "erase what happened".

To archive:

1. Disable every account in the tenant first. Archiving is refused while any of them can still sign
   in — an archived customer whose people still have access is the worst of both states, and the
   screen says how many accounts are in the way.
2. Open the tenant's **Details** and choose **Archive tenant**.

Two tenants can never be archived: **your own MSP organisation**, because that would disable the
accounts that administer the installation including yours, and **the tenant your own account belongs
to**.

---

## Filter what you are looking at

The **Tenant** control in the top bar narrows Sites and Users to one customer. Selecting your MSP
organisation shows only your own colleagues.

It is a filter and nothing more. It cannot show you anything your account could not already reach —
the scope is applied underneath, and choosing a tenant you have no access to simply returns nothing.
The selection follows you between pages and does not appear at all if your account reaches exactly
one tenant, because then it would be a control that looks like a choice and is not one.

---

## Where to go next

- [Managing users and access](managing-access.md) — accounts, roles, two-factor, Entra ID SSO
- [Roles and permissions](permissions.md) — what each role grants, in full
- [Getting started](getting-started.md) — the first hour after installing

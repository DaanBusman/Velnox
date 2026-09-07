# Managing users and access

**Everything about who can sign in to Velnox and what they are allowed to do.** Each section is one
task, written to be read while you are doing it.

For what each role grants, see [Roles and permissions](permissions.md). For the reasoning behind
these designs rather than the steps, see [Technical decisions](tech-decisions.md).

Every task here needs a permission of its own; the page tells you which one when you lack it, rather
than hiding the control and leaving you guessing.

---

## Add an account

**You need:** `users.manage` — MSP Super Administrator, MSP Administrator or Tenant Administrator.

1. Go to **Users** under Administration.
2. Choose **Add an account**.
3. Fill in the name, the email address and an initial password of at least 12 characters.
4. Save.

Velnox sends no email, so there is no invitation link. You set the initial password and pass it on
yourself, through whatever channel you would use for any other credential — not the same email that
carries the address of the installation.

The new account can sign in immediately and can do **nothing**: an account with no roles is
authenticated but not authorised. Give it a role next.

> There is no self-service password change and no administrator reset in this build. That is
> recorded in [Known gaps](known-gaps.md) rather than left to be discovered. Until it lands, an
> account's password is the one it was created with.

---

## Give someone a role

**You need:** `roles.manage`.

1. Go to **Users** and find the account.
2. Pick a role from **Grant a role**.
3. The grant takes effect on the account's next request — there is nothing else to apply.

Roles marked **MSP only** can be granted only to accounts in your own organisation, not to a
customer's staff. Velnox enforces that server-side, so it holds regardless of what the interface
offers.

[Roles and permissions](permissions.md) lists exactly what each role grants. Read it before granting
one for the first time: the difference between MSP Engineer and MSP Administrator is not user
management, it is *all* of identity administration, and that is not obvious from the names.

### Which role to give

- Someone who runs the fleet but should not administer people: **MSP Engineer**.
- Someone who administers people and the fleet but not the installation itself: **MSP Administrator**.
- Someone who needs to look and never touch — an auditor, a new colleague in their first week:
  **MSP Read Only**.
- Reserve **MSP Super Administrator** for the accounts that genuinely need installation-wide
  settings. It is the only role holding `system.manage`.

---

## Take a role away

**You need:** `roles.manage`.

Use **Take away** next to the role on the account.

The button is absent on the founding administrator, because the answer would be no. See
[The founding administrator](#the-founding-administrator) below.

Revoking a role does not sign the account out. It changes what the next request is allowed to do,
which is the thing that matters; a session with no permissions can reach the sign-out button and
nothing else.

---

## Disable or re-enable an account

**You need:** `users.manage`.

Use **Disable** on the account. That immediately revokes its sessions and refuses further sign-ins.
**Enable** puts it back exactly as it was, roles included.

Disable rather than delete when someone leaves. Deleting an account would orphan its audit history,
and the audit log is append-only precisely so that history survives; a disabled account keeps the
record of what it did intact and attributable.

---

## The founding administrator

The account created by the setup wizard is marked as the founding administrator, and Velnox treats
it differently in exactly two ways:

- **Its roles cannot be taken away.** Not by another administrator, and not by itself.
- **It cannot be disabled while no other enabled account can administer this installation.** Once a
  second administrator exists, disabling it is allowed.

Disabling stays possible because it is reversible by anyone who still holds permissions, and an
organisation does need a way to stop a departed administrator's account. Removing its permissions is
*not* reversible from inside the product, and that is the whole difference.

The interface says this next to the account rather than leaving you to discover a missing button.

**What this means for you:** one account is permanently privileged. Give it a strong password, enrol
it in two-factor authentication, and create a second administrator early so the founding account is
not the only way in — an account whose password is in one person's head is a single point of failure
regardless of what the software allows.

---

## Turn on two-factor authentication for yourself

**You need:** an account. This is per-person and needs no permission.

1. Go to **Security** under Administration.
2. Choose **Set up two-factor authentication**.
3. Scan the QR code with an authenticator app, or type the shown secret in by hand.
4. Enter one code from the app.
5. Save the ten recovery codes.

Nothing is switched on until step 4 succeeds. That ordering is deliberate: an enrolment that
activated before it was proven would lock you out of your own account with a secret your app never
actually stored.

**The recovery codes are shown once.** They are hashed the same way passwords are, so Velnox cannot
show them again — it does not have them. Save them somewhere that is neither the machine running
Velnox nor the phone holding the authenticator. If you lose them, you can generate a new set from
the same page while you are still signed in; the old set stops working the moment the new one is
created.

---

## Sign in when you have lost your authenticator

At the two-factor prompt, choose **Use a recovery code** and enter one of the codes you saved.

Each code works exactly once. Its use is written to the audit log, because a recovery code being
used is either a colleague having a bad day or an attacker having a good one, and the two look
identical at the moment it happens.

After you are in, go to **Security**, turn two-factor authentication off, and enrol again with the
new device. Generate a fresh set of recovery codes at the same time.

> Recovery-code use is logged but not yet alerted anywhere outside the audit log. That is in
> [Known gaps](known-gaps.md). Until it lands, treat the audit log as the place to look.

---

## Help someone who has lost both their device and their recovery codes

There is no administrator override in this build. Nobody, including a Super Administrator, can turn
another account's two-factor authentication off from the interface, and that is on purpose: an
override is a permanent bypass of the second factor for anyone who can reach the administrator
account.

What you can do:

1. **Disable the account** so it cannot be used while the situation is unresolved.
2. **Create a replacement account** and grant it the same roles.
3. Keep the disabled account for its audit history.

If you would rather have a break-glass reset than a replacement account, say so — it is a deliberate
omission, not an oversight, and the trade-off is worth revisiting with the reasoning visible.

---

## Require two-factor authentication

Velnox enforces three policies:

| Policy | Effect |
|---|---|
| `OPTIONAL` | Anyone may enrol; nobody must. The default. |
| `REQUIRED_FOR_PRIVILEGED` | Accounts holding a privileged permission must enrol before they can do anything else. |
| `REQUIRED` | Every account must enrol. |

A session that has not satisfied a required policy can reach exactly two things: enrolment, and
signing out. Every other endpoint refuses it. That is verified against *every* endpoint in the
build rather than a sample, so an endpoint added later cannot quietly escape the rule.

[Roles and permissions](permissions.md) lists which permissions count as privileged.

> **This build has no screen for changing the policy.** The enforcement is complete and tested; the
> setting is a database column that defaults to `OPTIONAL`, and the settings screen that writes it
> arrives with the rest of installation settings. Saying so is more useful than describing a button
> that is not there. In the meantime the Users page names the privileged accounts without a second
> factor, so the gap is visible even when the policy cannot yet be enforced for you.

---

## Connect Microsoft Entra ID

**You need:** `system.manage`, and in Entra the Application Administrator, Cloud Application
Administrator or Global Administrator role.

Go to **Single sign-on** under Administration. It is a six-step wizard, because connecting a
directory means switching between two browser tabs several times and the order matters.

| Step | What happens |
|---|---|
| 1. Before you start | What you need. Read it — a client secret is shown by Entra only once. |
| 2. App registration | Velnox shows the exact name and redirect URI to use. |
| 3. Identifiers | Paste the directory (tenant) ID and application (client) ID back. |
| 4. Client secret | Paste the secret **value**, not the secret ID. |
| 5. Who may sign in | Optionally restrict which email domains may authenticate. |
| 6. Save and check | Velnox stores it and fetches the provider's discovery document. |

Two details cause most failed attempts:

- **The redirect URI must match exactly.** Velnox derives it from the installation's own address and
  shows it with a copy button; a trailing slash is a different URI to Entra.
- **The secret value is shown once.** If you navigate away before copying it, delete that secret in
  Entra and create another. There is no way to read it back.

The client secret is encrypted before it is stored, is never returned by any API response, and never
appears in a log or an audit record. The page shows only whether a secret is present.

Step 6 is a real connection attempt against the provider, not a saved-successfully message. You find
out that the configuration is wrong now rather than at someone's first sign-in.

> **Signing in with Entra does not work yet.** The configuration, the discovery validation and the
> connection test are complete; the callback that turns a Microsoft identity into a Velnox session
> is not. The login page does not offer the button, so nothing here can strand you — but do not
> retire local passwords on the strength of a passing connection test. See
> [Known gaps](known-gaps.md).

---

## Read the audit log

**You need:** `audit.read` — Super Administrator, Administrator, MSP Read Only or Tenant
Administrator.

Go to **Audit log** under Administration. Events are newest first, and can be filtered by action.

Every authentication and authorisation event is recorded: sign-ins and their failures, sign-outs,
refused permissions, role grants and revocations, account status changes, two-factor enrolment and
recovery-code use, and changes to the identity provider.

The table is **append-only**, enforced by a database trigger that refuses `UPDATE` and `DELETE` —
including from Velnox itself. An event cannot be altered or removed after the fact by anyone who has
not been given a database superuser account on the machine, which is a different and much larger
thing to have.

Audit records never contain a password, a token, a secret or a recovery code. Field names that look
like credentials are redacted before anything is written, and there is a test pinning which names
survive, because that protection has silently regressed before.

---

## What is enforced where

Worth knowing when something is refused and you are trying to work out why.

- **The API decides.** Every permission check happens server-side. The interface hides controls you
  cannot use as a courtesy, not as the control — a request made by other means is refused the same
  way.
- **Grants carry a scope.** A grant covers its scope and everything beneath it: global, then tenant,
  then site, then cluster. Global scope is only assignable to members of your own organisation.
  Scopes below global become useful in phase 3, when there is more than one tenant.
- **A refusal is audited.** A 403 is a recorded event, not a silent no.

---

## Where to go next

- [Roles and permissions](permissions.md) — the full matrix of what each role grants
- [Getting started](getting-started.md) — the first hour after installing
- [Known gaps](known-gaps.md) — what is deliberately missing right now
- [Technical decisions](tech-decisions.md) — why these designs, and what they cost

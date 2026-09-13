# Getting started with Velnox

**This guide is for the person who has just installed Velnox and is looking at an empty screen.** It
covers the first hour: creating the first account, finding your way around, checking that the
installation is actually healthy, and knowing what does not exist yet.

For server requirements, the install command itself and the upgrade path, see
[Deployment](deployment.md). For everything about accounts, roles and sign-in, see
[Managing users and access](managing-access.md).

---

## What you need before you start

- A Debian 12/13 or Ubuntu 22.04/24.04 machine, 4 vCPU / 8 GB RAM / 60 GB disk, reachable on ports
  80 and 443. [Deployment](deployment.md) has the full requirements and the hypervisor settings that
  matter.
- The address operators will type. A DNS name is better than an IP address: an IP cannot carry a
  publicly trusted certificate, and the address is the thing you are least likely to be able to
  change later.
- A password manager you actually use. The installer prints a `MASTER_ENCRYPTION_KEY` at the end,
  and there is no recovery path if it is lost.

Velnox does not need internet access to run. It needs it once, during installation, to pull
container images.

---

## Install it

On the target machine, as a user with `sudo`:

```bash
sudo apt-get update && sudo apt-get install -y git && sudo git clone https://github.com/DaanBusman/Velnox.git /opt/velnox && sudo bash /opt/velnox/install.sh
```

The installer asks two questions — the address, and whether you want a self-signed certificate or a
publicly trusted one — then builds and starts everything. Five to ten minutes, most of it building
images.

The build step prints BuildKit's own progress rather than a spinner, so you can see which image is
being built and what it is doing. Lines are prefixed with the service they belong to — `[api ...]`
for the backend image, `[web ...]` for the frontend — and both are built in parallel, so the two
interleave. Everything on screen is also written to the install log.

When it finishes it prints the URL, the `MASTER_ENCRYPTION_KEY`, and the result of a verification
run against the installation it just created. **Read that verification result.** It is the
difference between "the installer exited 0" and "the software works", and those are not the same
claim.

If you chose a self-signed certificate, your browser warns you once when you first open the address.
That is expected, and not a sign that something went wrong: the certificate was issued by the
installation's own certificate authority, which your browser has never heard of.

You are not stuck with that choice. A running installation can be switched to a Let's Encrypt
certificate, or given one you already hold, at any time — see [Certificates](deployment.md#certificates),
and **Server management → Certificate** in the product for what is being served right now.

---

## Create the first administrator

Open the address. Because nobody has signed in yet, Velnox shows the setup wizard instead of a login
screen.

There are no default credentials anywhere in Velnox, so there is nothing to change afterwards and
nothing to forget to change. The wizard is the only way an account comes into existence on a fresh
installation, and it closes permanently once it has run.

You are asked for:

| Field | What it is for |
|---|---|
| Organisation name | Your own MSP. It names the root tenant and appears in the interface. |
| Your name | Shown on audit events, so "who did this" is a person rather than an email address. |
| Email address | Your sign-in name. Velnox sends no email; this is an identifier. |
| Password | At least 12 characters. The same rule applies to every account afterwards. |

Submitting it creates, in one database transaction: the MSP root tenant, the system roles, and your
account holding **MSP Super Administrator** at global scope. If any part fails, none of it happened
— you cannot end up with a half-initialised installation.

A second attempt at the wizard returns an error rather than creating another administrator.

### Your account is special, permanently

The account the wizard creates is the **founding administrator**. Its roles cannot be taken away by
anyone, including itself, and it cannot be disabled while no other enabled account can administer
the installation.

This exists because the alternative happened. An administrator could revoke their own last role,
and on an installation with one account — which is every installation on its first day — that
removed the last permission in the system. Signing in still worked. Nothing was allowed. The only
way back was a database prompt, in a product whose entire premise is that operators should not need
one.

The cost is real and worth stating: one account in your installation is permanently privileged, so
its password and its second factor matter more than any other. Give it a strong password and enrol
it in two-factor authentication before you do anything else.

---

## Set up two-factor authentication

Do this now rather than later, while there is exactly one account and you cannot lock a colleague
out by experimenting.

Go to **Security** under Administration. Enrolment shows a QR code, asks for one code from your
authenticator app to prove it works before anything is switched on, and then shows ten single-use
recovery codes.

The recovery codes are shown **once**. Save them somewhere that is not the machine running Velnox
and not the phone holding the authenticator — otherwise losing one device loses both halves.
[Managing users and access](managing-access.md) covers what to do when someone loses their
authenticator anyway.

---

## Find your way around

The sidebar is the shape of the finished product, not the shape of this build. Sections a later
phase implements are listed and lead to a page naming that phase, rather than being hidden — hiding
them would misrepresent what Velnox is for, and filling them with sample data would misrepresent
reality.

Working today:

| Where | What it does |
|---|---|
| **Dashboard** | Installation state, and prompts for what is worth doing next |
| **Users** | Accounts, roles, enabling and disabling — see [Managing users and access](managing-access.md) |
| **Roles & permissions** | What each role grants — see [Roles and permissions](permissions.md) |
| **Audit log** | Every authentication and authorisation event, newest first |
| **Security** | Two-factor authentication for your own account |
| **Single sign-on** | The Microsoft Entra ID wizard |
| **Server management** | The installation itself: its audit log, its certificate, its version |
| **Settings → About** | Version, build commit, licence and the source offer |
| **Documentation** | This documentation, offline, stamped with the running version |

**Server management** opens as a window over whatever you were doing, from the bottom of the
sidebar, and closes back onto it. It groups everything about the Velnox server itself, as opposed to
the infrastructure it manages, and it appears only for an MSP Super Administrator — every panel in
it needs `system.manage`.

Waiting on a later phase: tenants and sites (phase 3); clusters, nodes, virtual machines,
containers, storage and networks (phase 4); jobs (phase 5); updates (phase 6); major upgrades
(phase 8); migrations (phase 11). [Roadmap](roadmap.md) has the full order and what each phase
delivers.

---

## Change the language or the theme

Both are in the top bar, and both are per-person rather than per-installation: your colleague's
choice does not change yours.

Velnox ships in English and Dutch. Every visible string comes from a translation catalogue — there
are no English sentences hiding in the code waiting to appear in the middle of a Dutch page — and
the API returns error *codes* rather than sentences, so a message is rendered in the reader's
language rather than the server's. [Localization architecture](i18n.md) explains how that is
enforced.

The installation-wide defaults for new accounts are `VELNOX_DEFAULT_LOCALE` and
`VELNOX_DEFAULT_TIMEZONE` in `.env`.

---

## Check that the installation is healthy

Three levels of answer, in increasing order of thoroughness.

**From the interface:** the Dashboard shows the state of each dependency.

**From anywhere:** `https://<your-address>/readyz` returns the status of the database, Redis, the
queue and the migration state as JSON. It is deliberately unauthenticated so an external monitor can
poll it without holding a credential; it contains no secrets and no configuration.

**From the machine, thoroughly:**

```bash
cd /opt/velnox && bash scripts/verify-stack.sh https://velnox.example.internal
```

That is the same verification the installer runs: thirty-five checks covering TLS, the security
headers, the API, the worker, the queue, the database migrations, localisation, and the version
agreement between the running build and its documentation. Run it after any change to the machine.

When something is wrong, [Deployment](deployment.md) has the diagnosis section, and the container
logs are the next place to look:

```bash
cd /opt/velnox && sudo docker compose -f deploy/compose/docker-compose.yml --env-file .env logs -f api
```

---

## Read this documentation offline

Velnox is installed on management networks that frequently cannot reach the internet, and the moment
you most need documentation is the moment something is broken — which is a bad time to discover it
lives on GitHub. So it ships inside the build, under **Documentation**.

Every page states the version it was built from. That string comes from the same place the running
software reports its version, produced by the same build, so the documentation and the software
cannot be a release apart. If a page ever shows a version differing from the one on
**Settings → About**, the page says so rather than letting you read instructions for another
release.

---

## What is not here yet

Being direct about this is more useful than a feature list.

Velnox cannot yet talk to Proxmox. There is no cluster, no node, no virtual machine and no job
touching real infrastructure in this build — that begins in phase 4, and the guides for **creating a
cluster** and **adding a node** are written when the feature is. Multi-tenancy beyond the MSP root
tenant arrives in phase 3, so today every account lives in your own organisation.

What exists is the foundation those depend on and cannot be retrofitted onto: authentication,
permissions, auditing, encryption, localisation, the job runner and the deployment.
[Roadmap](roadmap.md) lists what each phase adds; [Known gaps](known-gaps.md) is the honest list of
what is deliberately missing or unfinished right now.

---

## Where to go next

- [Managing users and access](managing-access.md) — accounts, roles, two-factor, Entra ID SSO
- [Roles and permissions](permissions.md) — what each role grants, in full
- [Organising your fleet](organising-your-fleet.md) — tenants, sites and scoping a grant
- [Deployment](deployment.md) — requirements, upgrades, backup, diagnosis
- [Architecture](architecture.md) — how the system is put together, and why

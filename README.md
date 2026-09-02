# Velnox

**Self-hosted MSP management platform for Proxmox VE fleets.**

Velnox lets a Managed Service Provider run many customers' Proxmox VE environments from one place:
central inventory, health, update management, rolling updates, guided major upgrades (PVE 8 → 9 and
Ceph), root credential rotation, and VMware/Hyper-V migration assistance — with real multi-tenancy,
permission-based RBAC, Microsoft Entra ID SSO and full audit logging.

---

## ⚠️ Project status: Phase 1 of 15

The **foundation** is built and runs: six services under Docker Compose, PostgreSQL with
migrations, a Redis-backed job queue with a worker, English/Dutch localization, structured logging
with secret redaction, health and readiness probes, OpenAPI, and AGPL §13 licence compliance.

> **There is no authentication in this build.** Every endpoint is open and every page is public.
> Authentication and RBAC arrive in Phase 2, multi-tenancy in Phase 3, Proxmox inventory in Phase 4.
> **Do not put this on a network you do not fully control.**

What each phase adds, and what is deliberately missing today:
[docs/roadmap.md](docs/roadmap.md) · [docs/known-gaps.md](docs/known-gaps.md)

---

## Quick start

On a fresh Debian 12/13 or Ubuntu 22.04/24.04 server:

```bash
sudo apt-get update && sudo apt-get install -y git && sudo git clone https://github.com/DaanBusman/Velnox.git /opt/velnox && sudo /opt/velnox/install.sh
```

The installer installs Docker if it is missing, generates secrets, builds the images, starts the
stack, verifies it and prints the URL. Re-running it is safe and is also the upgrade path — but take
a database dump first, because migrations only run forwards:
[Upgrading](docs/deployment.md#upgrading).

Full options, sizing and hypervisor VM settings: [docs/deployment.md](docs/deployment.md).

> **Back up `MASTER_ENCRYPTION_KEY`,** which the installer prints when it finishes. Every credential
> Velnox stores is encrypted under a key derived from it. Lose it and there is no recovery path, by
> design.

### Verify a running installation

```bash
./scripts/verify-stack.sh https://your-velnox-host
```

Asserts against the running stack: every dependency reachable, migrations applied, security headers
set, both languages served, the licence offer published, and the data tier not exposed to the host.

---

## Development

```bash
pnpm install && pnpm build
```

| Command | What it does |
|---|---|
| `pnpm lint` | ESLint plus glossary and locale validation |
| `pnpm typecheck` | TypeScript across every package |
| `pnpm test` | Unit tests (redaction, config, i18n, migrations, error shape, queue) |
| `pnpm run validate:licenses` | Fails on any dependency licence incompatible with AGPL-3.0 |
| `pnpm run validate:i18n` | Fails on a malformed glossary row or a missing translation key |
| `node scripts/check-doc-sync.mjs` | Reports Dutch docs that have fallen behind their English source |

Two lint rules are load-bearing rather than stylistic: raw SQL is banned because it bypasses the
tenancy layer, and `rejectUnauthorized: false` is banned because Velnox pins certificate
fingerprints instead. Both are enforced in `eslint.config.mjs`.

---

## Documentation

| Document | Contents |
|---|---|
| [deployment.md](docs/deployment.md) | Deploying on Debian/Ubuntu with Docker, sizing, and VM settings for Proxmox, ESXi and Hyper-V |
| [architecture.md](docs/architecture.md) | System architecture, security boundaries, monorepo layout, subsystem designs |
| [tech-decisions.md](docs/tech-decisions.md) | ADR log — every stack choice with the alternatives and why they lost |
| [database-schema.md](docs/database-schema.md) | Entity model, key columns, tenancy and security constraints |
| [service-diagram.md](docs/service-diagram.md) | Container topology, startup ordering, health checks, trust boundaries |
| [i18n.md](docs/i18n.md) | Localization: glossary, catalogues, error codes, what stays untranslated |
| [risks.md](docs/risks.md) | Ranked technical risk register with mitigations |
| [roadmap.md](docs/roadmap.md) | Phases 1–15 with per-phase acceptance criteria |
| [known-gaps.md](docs/known-gaps.md) | What is deliberately not built, and what is not built *yet* |

Nederlandse vertalingen: [docs/nl/](docs/nl/). English is canonical.

Written per the phase that implements them: `security.md`, `rbac.md`, `multi-tenancy.md`,
`proxmox-integration.md`, `update-engine.md`, `major-upgrades.md`, `migrations.md`,
`build-system.md`, `microsoft-sso.md`.

---

## Stack

| Layer | Choice |
|---|---|
| Frontend | Next.js 15 (App Router), React 19, TypeScript, Tailwind 4 |
| Backend | NestJS 11 on Node 22, REST + OpenAPI |
| Worker | BullMQ, no listening port |
| Database | PostgreSQL 16 + Prisma |
| Queue / cache | Redis 7 |
| Reverse proxy | Caddy 2 |
| Localization | English + Dutch, ICU catalogues over a controlled vocabulary |

Rationale for each: [docs/tech-decisions.md](docs/tech-decisions.md).

---

## Principles this project is held to

- **No fake success.** An action reports success only after it has been verified. Unimplemented
  functionality is labelled with the phase that will build it — never mocked, never filled with
  sample data.
- **Tenant isolation is a server-side security boundary**, enforced at the query layer and covered
  by CI-blocking cross-tenant tests. Frontend filtering is cosmetic.
- **Secrets never leave the worker.** No API response, log line, job event or audit record contains
  credential material, and a test asserts it.
- **The API container performs no outbound automation.** SSH, Proxmox and WinRM adapters exist only
  in the worker role — enforced in the code and again at the network layer, where only the worker
  joins the egress network.
- **Destructive workflows stop.** Blockers cannot be bypassed from the UI, and risky remediations
  require an approval that shows the exact change set.

---

## Licence

Velnox is free software, licensed under the **GNU Affero General Public License, version 3 or later**
([LICENSE](LICENSE)).

You may run it commercially, modify it and redistribute it. Because Velnox is accessed over a
network, AGPL **section 13** applies: anyone using a *modified* version over a network must be
offered that version's source. Velnox implements this in the product — **Settings → About** and
`GET /api/v1/system/source` show the version, build commit and a source link, driven by the
build-time `VELNOX_SOURCE_URL`. If you run a modified build, point that at your own source.

See [NOTICE](NOTICE) for the copyright notice and the §13 statement.

## Trademarks

Velnox™ and the Velnox logo are trademarks of **The Velnox Foundation**. The AGPLv3 grants no
trademark rights — see [TRADEMARK.md](TRADEMARK.md). You are free to fork; please give your fork its
own name. Velnox is built to make that easy: the product name comes from
`system_settings.product_name`, not from hardcoded strings.

Proxmox®, VMware®, Microsoft®, Hyper-V®, Ceph®, Debian®, Docker® and PostgreSQL® are trademarks of
their respective owners. Velnox is not affiliated with, endorsed by, or sponsored by any of them.

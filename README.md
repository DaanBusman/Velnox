# Velnox

**Self-hosted MSP management platform for Proxmox VE fleets.**

Velnox lets a Managed Service Provider run many customers' Proxmox VE environments from one place:
central inventory, health, update management, rolling updates, guided major upgrades (PVE 8 → 9),
root credential rotation, and VMware/Hyper-V migration assistance — with real multi-tenancy,
permission-based RBAC, Microsoft Entra ID SSO and full audit logging.

---

## ⚠️ Project status

**Phase 0 — architecture and planning. There is no application code yet.**

This repository currently contains the design documents produced in Phase 0. Nothing is installable
or runnable at this point. Implementation begins at Phase 1 after the architecture is approved.

| Document | Contents |
|---|---|
| [docs/architecture.md](docs/architecture.md) | System architecture, security boundaries, monorepo layout, subsystem designs |
| [docs/tech-decisions.md](docs/tech-decisions.md) | ADR log — every stack choice with the alternatives and why they lost |
| [docs/database-schema.md](docs/database-schema.md) | Entity model, key columns, tenancy and security constraints |
| [docs/service-diagram.md](docs/service-diagram.md) | Container topology, startup ordering, health checks, trust boundaries |
| [docs/i18n.md](docs/i18n.md) | Localization architecture: glossary, catalogues, error codes, what stays untranslated |
| [docs/risks.md](docs/risks.md) | Ranked technical risk register with mitigations, decisions taken, open questions |
| [docs/roadmap.md](docs/roadmap.md) | Phases 1–15 (9 split into 9A/9B) with per-phase acceptance criteria |
| [docs/known-gaps.md](docs/known-gaps.md) | What is deliberately not built, and what is not built *yet* |

Nederlandse vertalingen: [docs/nl/](docs/nl/). English is canonical.

Documents planned per the brief and written during the phase that implements them:
`security.md`, `rbac.md`, `multi-tenancy.md`, `proxmox-integration.md`, `update-engine.md`,
`major-upgrades.md`, `migrations.md`, `build-system.md`, `microsoft-sso.md`.

---

## Planned stack

| Layer | Choice |
|---|---|
| Frontend | Next.js 15 (App Router), TypeScript, Tailwind, shadcn/ui, TanStack Query + Table |
| Backend | NestJS 11 on Node 22, REST + SSE, OpenAPI |
| Worker | NestJS standalone + BullMQ |
| Database | PostgreSQL 16 + Prisma |
| Queue / cache | Redis 7 |
| Reverse proxy | Caddy 2 |
| Deployment | Docker Compose on Debian 12/13 |
| Localization | English + Dutch, ICU catalogues over a controlled vocabulary |

Rationale for each: [docs/tech-decisions.md](docs/tech-decisions.md).

---

## Principles this project is held to

- **No fake success.** An action reports success only after it has been verified. Unimplemented
  functionality is behind a feature flag and listed in `known-gaps.md` — never mocked in the UI.
- **Tenant isolation is a server-side security boundary**, enforced at the query layer and covered
  by CI-blocking cross-tenant tests. Frontend filtering is cosmetic.
- **Secrets never leave the worker.** No API response, log line, job event or audit record contains
  credential material.
- **The API container performs no outbound automation.** SSH, Proxmox and WinRM adapters exist only
  in the worker role, so a request handler has no code path to remote execution.
- **Destructive workflows stop.** Blockers cannot be bypassed from the UI, and risky remediations
  require an approval that shows the exact change set.

---

## Quick start

Not yet available. From Phase 1 onward:

```bash
docker compose up --build
```

and from Phase 14, on a clean Debian host:

```bash
sudo ./install.sh
```

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
Proxmox® and Proxmox VE® are registered trademarks of Proxmox Server Solutions GmbH.
VMware®, ESXi™ and vSphere® are trademarks of Broadcom Inc.
Microsoft®, Hyper-V®, Azure® and Entra ID™ are trademarks of Microsoft Corporation.
Velnox is not affiliated with, endorsed by, or sponsored by any of these companies.

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
| [docs/risks.md](docs/risks.md) | Ranked technical risk register with mitigations, plus open questions |
| [docs/roadmap.md](docs/roadmap.md) | Phases 1–15 with per-phase acceptance criteria |
| [docs/known-gaps.md](docs/known-gaps.md) | What is deliberately not built, and what is not built *yet* |

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

## Licence and trademarks

Licence: to be decided before Phase 1.

Velnox™ and the Velnox logo are trademarks of **The Velnox Foundation**.
Proxmox® and Proxmox VE® are registered trademarks of Proxmox Server Solutions GmbH.
VMware®, ESXi™ and vSphere® are trademarks of Broadcom Inc.
Microsoft®, Hyper-V®, Azure® and Entra ID™ are trademarks of Microsoft Corporation.
Velnox is not affiliated with, endorsed by, or sponsored by any of these companies.

# Velnox — Nederlandse documentatie

> **Vertaling.** Bron: [README.md](../../README.md) @ `5fd136a`.
> **Engels is leidend.** Bij verschil tussen deze tekst en de Engelse versie geldt de Engelse tekst.

**Velnox is een self-hosted MSP-beheerplatform voor Proxmox VE-omgevingen.**

Velnox stelt een Managed Service Provider in staat om de Proxmox VE-omgevingen van meerdere klanten
vanaf één plek te beheren: centrale inventaris, gezondheid, updatebeheer, rolling updates, begeleide
major upgrades (PVE 8 → 9), Ceph-upgrades, credentialrotatie en migratiebegeleiding vanaf VMware en
Hyper-V — met echte multi-tenancy, rechten-gebaseerde RBAC, Microsoft Entra ID SSO en volledige
auditlogging.

---

## ⚠️ Projectstatus

**Phase 0 — architectuur en planning. Er is nog geen applicatiecode.**

Deze repository bevat op dit moment uitsluitend de ontwerpdocumenten uit Phase 0. Er valt nog niets
te installeren of te starten. De implementatie begint bij Phase 1, na goedkeuring van de
architectuur.

| Document | Inhoud |
|---|---|
| [architecture.md](architecture.md) | Systeemarchitectuur, security boundaries, monorepo-indeling, subsystemen |
| [tech-decisions.md](tech-decisions.md) | ADR-log — elke stackkeuze met alternatieven en waarom die afvielen |
| [database-schema.md](database-schema.md) | Entiteitenmodel, belangrijkste kolommen, tenancy- en security-constraints |
| [service-diagram.md](service-diagram.md) | Containertopologie, startvolgorde, health checks, trust boundaries |
| [i18n.md](i18n.md) | Lokalisatiearchitectuur: woordenlijst, catalogi, foutcodes |
| [risks.md](risks.md) | Gerangschikt technisch risicoregister, genomen beslissingen, open vragen |
| [roadmap.md](roadmap.md) | Phase 1–15 (9 gesplitst in 9A/9B) met acceptatiecriteria per fase |
| [known-gaps.md](known-gaps.md) | Wat bewust niet gebouwd wordt, en wat nog niet gebouwd is |

Documenten die volgens de opdracht later volgen, geschreven in de fase die ze implementeert:
`security.md`, `rbac.md`, `multi-tenancy.md`, `proxmox-integration.md`, `update-engine.md`,
`major-upgrades.md`, `migrations.md`, `build-system.md`, `microsoft-sso.md`.

---

## Geplande stack

| Laag | Keuze |
|---|---|
| Frontend | Next.js 15 (App Router), TypeScript, Tailwind, shadcn/ui, TanStack Query + Table |
| Backend | NestJS 11 op Node 22, REST + SSE, OpenAPI |
| Worker | NestJS standalone + BullMQ |
| Database | PostgreSQL 16 + Prisma |
| Queue / cache | Redis 7 |
| Reverse proxy | Caddy 2 |
| Deployment | Docker Compose op Debian 12/13 |
| Lokalisatie | Engels + Nederlands, ICU-catalogi op een vaste woordenlijst |

---

## Uitgangspunten waaraan dit project wordt gehouden

- **Geen nep-succes.** Een actie meldt pas succes nadat die geverifieerd is. Niet-geïmplementeerde
  functionaliteit zit achter een feature flag en staat in `known-gaps.md` — nooit nagebootst in de UI.
- **Tenant-isolatie is een server-side security boundary**, afgedwongen in de querylaag en gedekt door
  CI-blokkerende cross-tenant tests. Filteren in de frontend is cosmetisch.
- **Secrets verlaten de worker nooit.** Geen enkele API-respons, logregel, jobgebeurtenis of
  auditrecord bevat credentialmateriaal.
- **De API-container doet geen outbound automation.** SSH-, Proxmox- en WinRM-adapters bestaan alleen
  in de worker-rol, waardoor een request handler geen code path naar remote execution heeft.
- **Destructieve workflows stoppen.** Blokkades kunnen niet vanuit de UI worden omzeild, en riskante
  herstelacties vereisen een goedkeuring die de exacte wijzigingsset toont.

---

## Snel starten

Nog niet beschikbaar. Vanaf Phase 1:

```bash
docker compose up --build
```

en vanaf Phase 14, op een schone Debian-host:

```bash
sudo ./install.sh
```

---

## Licentie

Velnox is vrije software onder de **GNU Affero General Public License, versie 3 of later**
([LICENSE](../../LICENSE)).

Je mag het commercieel draaien, aanpassen en verspreiden. Omdat Velnox via een netwerk wordt
benaderd, geldt **artikel 13** van de AGPL: wie een *aangepaste* versie via een netwerk gebruikt, moet
de bijbehorende broncode van die versie aangeboden krijgen. Velnox implementeert dit in het product
zelf — **Instellingen → Over** en `GET /api/v1/system/source` tonen de versie, de build-commit en een
bronlink, aangestuurd door de build-variabele `VELNOX_SOURCE_URL`. Draai je een aangepaste build, wijs
die dan naar je eigen broncode.

## Handelsmerken

Velnox™ en het Velnox-logo zijn handelsmerken van **The Velnox Foundation**. De AGPLv3 verleent geen
rechten op handelsmerken — zie [TRADEMARK.md](../../TRADEMARK.md). Je mag vrij forken; geef je fork
alsjeblieft een eigen naam. Velnox is zo gebouwd dat dat eenvoudig is: de productnaam komt uit
`system_settings.product_name`, niet uit vastgelegde teksten in de code.

Proxmox®, VMware®, Microsoft®, Hyper-V®, Ceph®, Debian®, Docker® en PostgreSQL® zijn handelsmerken van
hun respectieve eigenaren. Velnox is niet gelieerd aan, onderschreven door of gesponsord door een van
deze partijen.

# Velnox — Nederlandse documentatie

> **Vertaling.** Bron: [README.md](../../README.md) @ `PENDING`.
> **Engels is leidend.** Bij verschil tussen deze tekst en de Engelse versie geldt de Engelse tekst.

**Velnox is een self-hosted MSP-beheerplatform voor Proxmox VE-omgevingen.**

Velnox stelt een Managed Service Provider in staat om de Proxmox VE-omgevingen van meerdere klanten
vanaf één plek te beheren: centrale inventaris, gezondheid, updatebeheer, rolling updates, begeleide
major upgrades (PVE 8 → 9 en Ceph), credentialrotatie en migratiebegeleiding vanaf VMware en
Hyper-V — met echte multi-tenancy, rechten-gebaseerde RBAC, Microsoft Entra ID SSO en volledige
auditlogging.

---

## ⚠️ Projectstatus: fase 1 van 15

De **basis** is gebouwd en draait: zes services onder Docker Compose, PostgreSQL met migraties, een
door Redis ondersteunde jobwachtrij met worker, Engelse en Nederlandse lokalisatie, gestructureerde
logging met secretredactie, health- en readiness-probes, OpenAPI, en naleving van AGPL artikel 13.

> **Deze build kent geen authenticatie.** Elk endpoint staat open en elke pagina is publiek.
> Authenticatie en RBAC komen in fase 2, multi-tenancy in fase 3, Proxmox-inventaris in fase 4.
> **Zet dit niet op een netwerk dat je niet volledig beheert.**

Wat elke fase toevoegt, en wat er vandaag bewust ontbreekt:
[roadmap.md](roadmap.md) · [known-gaps.md](known-gaps.md)

---

## Snel starten

Vereist Docker en Docker Compose. Verder niets — Node en pnpm zijn alleen nodig voor ontwikkeling.

```bash
./scripts/gen-env.sh
```

```bash
docker compose -f deploy/compose/docker-compose.yml --env-file .env up --build --detach --wait
```

Open daarna **https://localhost**. Caddy geeft een eigen certificaat uit, dus de browser waarschuwt
één keer; dat hoort zo bij een appliance die je op hostnaam of IP benadert.

`gen-env.sh` genereert sterke secrets en weigert een bestaande `.env` te overschrijven.

> **Maak een back-up van `MASTER_ENCRYPTION_KEY`, los van de database.** Elk credential dat Velnox
> opslaat is versleuteld met een sleutel die daarvan is afgeleid. Raak je hem kwijt, dan is er geen
> herstelpad — dat is een ontwerpkeuze.

Wil je de wachtrij daadwerkelijk door de worker zien lopen, zet dan `VELNOX_DEV_ENDPOINTS=true` in
`.env` en gebruik de zelftestkaart op het dashboard. Die vlag stelt een niet-geauthenticeerd
diagnostisch endpoint bloot en verdwijnt in fase 2.

### De installatie verifiëren

```bash
./scripts/verify-stack.sh
```

Toetst de acceptatiecriteria van fase 1 tegen de draaiende stack: elke afhankelijkheid bereikbaar,
migraties toegepast, security headers gezet, beide talen geserveerd, het bronaanbod gepubliceerd, de
wachtrij die een echte job afrondt, en de datalaag die niet aan de host is blootgesteld.

---

## Ontwikkelen

```bash
pnpm install && pnpm build
```

| Commando | Wat het doet |
|---|---|
| `pnpm lint` | ESLint plus validatie van woordenlijst en taalcatalogi |
| `pnpm typecheck` | TypeScript over elk package |
| `pnpm test` | Unittests (redactie, configuratie, i18n, migraties, foutvorm, wachtrij) |
| `pnpm run validate:licenses` | Faalt op elke afhankelijkheid met een licentie die niet AGPL-3.0-compatibel is |
| `pnpm run validate:i18n` | Faalt op een misvormde woordenlijstrij of een ontbrekende vertaalsleutel |
| `node scripts/check-doc-sync.mjs` | Meldt Nederlandse documenten die achterlopen op hun Engelse bron |

Twee lintregels zijn dragend in plaats van stilistisch: ruwe SQL is verboden omdat het de
tenancy-laag omzeilt, en `rejectUnauthorized: false` is verboden omdat Velnox
certificaatvingerafdrukken vastlegt. Beide staan in `eslint.config.mjs`.

---

## Documentatie

| Document | Inhoud |
|---|---|
| [architecture.md](architecture.md) | Systeemarchitectuur, security boundaries, monorepo-indeling, subsystemen |
| [tech-decisions.md](tech-decisions.md) | ADR-log — elke stackkeuze met alternatieven en waarom die afvielen |
| [database-schema.md](database-schema.md) | Entiteitenmodel, belangrijkste kolommen, tenancy- en security-constraints |
| [service-diagram.md](service-diagram.md) | Containertopologie, startvolgorde, health checks, trust boundaries |
| [i18n.md](i18n.md) | Lokalisatie: woordenlijst, catalogi, foutcodes, wat onvertaald blijft |
| [risks.md](risks.md) | Gerangschikt technisch risicoregister met mitigaties |
| [roadmap.md](roadmap.md) | Fase 1–15 met acceptatiecriteria per fase |
| [known-gaps.md](known-gaps.md) | Wat bewust niet gebouwd wordt, en wat nog niet gebouwd is |

---

## Stack

| Laag | Keuze |
|---|---|
| Frontend | Next.js 15 (App Router), React 19, TypeScript, Tailwind 4 |
| Backend | NestJS 11 op Node 22, REST + OpenAPI |
| Worker | BullMQ, zonder luisterpoort |
| Database | PostgreSQL 16 + Prisma |
| Queue / cache | Redis 7 |
| Reverse proxy | Caddy 2 |
| Lokalisatie | Engels + Nederlands, ICU-catalogi op een vaste woordenlijst |

---

## Uitgangspunten waaraan dit project wordt gehouden

- **Geen nep-succes.** Een actie meldt pas succes nadat die geverifieerd is. Niet-geïmplementeerde
  functionaliteit is gelabeld met de fase die haar bouwt — nooit nagebootst, nooit gevuld met
  voorbeeldgegevens.
- **Tenant-isolatie is een server-side security boundary**, afgedwongen in de querylaag en gedekt door
  CI-blokkerende cross-tenant tests. Filteren in de frontend is cosmetisch.
- **Secrets verlaten de worker nooit.** Geen enkele API-respons, logregel, jobgebeurtenis of
  auditrecord bevat credentialmateriaal, en een test controleert dat.
- **De API-container doet geen outbound automation.** SSH-, Proxmox- en WinRM-adapters bestaan alleen
  in de worker-rol — afgedwongen in de code én op netwerkniveau, waar alleen de worker aan het
  egressnetwerk hangt.
- **Destructieve workflows stoppen.** Blokkades kunnen niet vanuit de UI worden omzeild, en riskante
  herstelacties vereisen een goedkeuring die de exacte wijzigingsset toont.

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

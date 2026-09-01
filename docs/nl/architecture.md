# Velnox — Architectuur

> **Vertaling.** Bron: [docs/architecture.md](../architecture.md) @ `5fd136a`.
> **Engels is leidend.** Bij verschil tussen deze tekst en de Engelse versie geldt de Engelse tekst.

> Velnox is een self-hosted MSP-beheerplatform voor Proxmox VE-omgevingen.
> Velnox™ is een handelsmerk van **The Velnox Foundation**.

**Status:** Fase 1 geïmplementeerd. Secties over latere fasen blijven ontwerpvoorstellen; waar fase 1
een keuze uit fase 0 heeft gewijzigd, staat dat ter plekke gemarkeerd als *Gewijzigd in fase 1*.
**Documentversie:** 0.2.0
**Doelplatform:** Debian 12 (bookworm) / Debian 13 (trixie), x86_64, Docker + Docker Compose.

---

## 1. Scope en ontwerpdoelen

Velnox beheert veel *onafhankelijke* Proxmox VE-omgevingen van veel *onafhankelijke* klanten van één
MSP. Die ene zin bepaalt elke architectuurkeuze:

| Doel | Gevolg |
|---|---|
| Meerdere klanten op één installatie | Harde, server-side multi-tenancy; isolatie is een security boundary, geen UI-filter |
| Handelingen op productie-hypervisors | Elke muterende actie is een auditbare, hervatbare, annuleerbare job — nooit een inline HTTP-handler |
| Root-credentials van infrastructuur van derden | Envelope-versleutelde secret store met vervangbare backend; secrets bereiken nooit logs, joboutput of de browser |
| Destructieve workflows (major upgrades, herstarts) | Data-gedreven playbooks met preflight → herstelactie → hercontrole → uitvoeren → valideren, en expliciete goedkeuringspunten |
| Levering als appliance | Reproduceerbare build-pipeline: dev compose → tar.gz-bundel → zelfuitpakkende installer → Debian ISO |
| Leveranciers veranderen (VMware, Hyper-V, Vault, toekomstige PVE-versies) | Alles wat extern is zit achter een adapter-interface met een register |

### Buiten scope voor v1 (expliciet vastgelegd, zodat niemand iets anders aanneemt)

- Velnox is **geen** monitoring-/metrics-TSDB. Het legt inventaris en gezondheid op momentbasis vast,
  geen hoogfrequente tijdreeksen. Langetermijnmetrics blijven een toekomstige Prometheus-integratie.
- Velnox vervangt Proxmox Backup Server **niet**. Het orkestreert; het slaat geen VM-data op.
  PBS-instanties zijn in v1 **geen** first-class inventaris (uitgesteld per beslissing, zie
  [known-gaps.md](known-gaps.md)) — het upgradeframework is zo gebouwd dat een PBS-playbook later past.
- Velnox biedt in v1 **geen** selfserviceportaal voor eindklanten. Tenant-gebruikers zijn operators,
  geen eindklanten.

**In scope per beslissing (2026-08-31):** Ceph major upgrades (§10.1), optionele maar aanbevolen
meervoudige authenticatie (§5), Engelse en Nederlandse lokalisatie met een vertaalklare woordenlijst
([i18n.md](i18n.md)), en air-gapped installatie vanaf een self-contained artifact (§13). Het project is
gelicentieerd onder **AGPLv3**, wat een concrete producteis met zich meebrengt — zie §15.

---

## 2. Systeemoverzicht

```
                        ┌──────────────────────────────┐
   Browser  ──HTTPS──►  │  reverse-proxy (Caddy)       │
                        │  TLS, HSTS, security headers │
                        └──────┬───────────────┬───────┘
                               │ /             │ /api/v1
                               ▼               ▼
                     ┌───────────────┐   ┌──────────────────┐
                     │ web (Next.js) │   │ api (NestJS)     │
                     │ SSR + BFF     │──►│ REST + SSE       │
                     └───────────────┘   └───┬──────┬───────┘
                                             │      │
                            ┌────────────────┘      └────────────┐
                            ▼                                    ▼
                     ┌─────────────┐                      ┌─────────────┐
                     │ PostgreSQL  │                      │   Redis     │
                     │ bron van    │◄─────────────────────│ queue +     │
                     │ waarheid    │                      │ pub/sub     │
                     └─────────────┘                      └──────┬──────┘
                            ▲                                    │
                            └────────────────┐      ┌────────────┘
                                             │      ▼
                                        ┌────┴──────────────┐
                                        │ worker (NestJS)   │
                                        │ BullMQ processors │
                                        └────┬──────────────┘
                                             │
                       ┌─────────────────────┼──────────────────────┐
                       ▼                     ▼                      ▼
              ┌────────────────┐   ┌──────────────────┐   ┌──────────────────┐
              │ Proxmox HTTPS  │   │ SSH (ssh2)       │   │ VMware / Hyper-V │
              │ API :8006      │   │ root@node        │   │ REST / WinRM     │
              └────────────────┘   └──────────────────┘   └──────────────────┘
```

Volledig servicediagram, poorten, health checks en afhankelijkheidsvolgorde:
[service-diagram.md](service-diagram.md).

### Waarom deze splitsing

- **api** beheert HTTP, authenticatie/autorisatie, validatie en het *indienen* van jobs. Het praat
  nooit met een node, opent nooit een SSH-verbinding en voert nooit een shellcommando uit. Dit is een
  bewuste security boundary: een request handler kan niet tot remote execution verleid worden omdat er
  geen code path naartoe bestaat.
- **worker** voert alle outbound automation uit. Het is de enige container waarin de Proxmox-, SSH- en
  WinRM-adapters geladen zijn, en de enige die credentials ontsleutelt voor gebruik.
- **web** rendert server-side en houdt geen token vast. Caddy serveert de UI en de API op één origin,
  waardoor de sessiecookie `HttpOnly`, `SameSite=Lax` en same-origin blijft, en Server Components de
  API over het interne Docker-netwerk lezen. Zie de wijziging uit fase 1 in §12.
- **PostgreSQL is de bron van waarheid** voor jobs. Redis is het *transport*. Wordt Redis gewist, dan
  gaat er geen jobhistorie, auditspoor of goedkeuringsbeslissing verloren — alleen planning die op dat
  moment liep, en die wordt bij het starten van de worker verzoend.

---

## 3. Monorepo-indeling

```
velnox/
├─ apps/
│  ├─ api/                     # NestJS HTTP-API (REST + SSE), geen outbound automation
│  │  ├─ src/modules/          # auth, users, tenants, sites, rbac, clusters, nodes,
│  │  │                        # vms, updates, upgrades, migrations, jobs, audit,
│  │  │                        # alerts, settings, setup
│  │  ├─ src/common/           # guards, interceptors, filters, pipes, request-context
│  │  └─ test/                 # e2e: autorisatie, tenant-isolatie, API-contract
│  ├─ worker/                  # NestJS standalone app, BullMQ processors
│  │  └─ src/processors/       # discovery, inventory, update, rolling-update,
│  │                           # major-upgrade, rotation, migration, scheduler
│  └─ web/                     # Next.js App Router frontend + BFF-proxy
│     ├─ app/(auth)/           # login, sso callback, installatiewizard
│     ├─ app/(dashboard)/      # sidebar-shell en alle ingelogde routes
│     ├─ components/           # ui/ (shadcn), data-table/, status/, forms/
│     └─ lib/                  # api client, sessie, rechten-helpers
├─ packages/
│  ├─ db/                      # Prisma-schema, migraties, seed, tenancy-extensie
│  ├─ shared/                  # zod-contracten, DTO's, rechtencatalogus, enums, fouten
│  ├─ crypto/                  # envelope-encryptie, secret store-interface + DB-backend
│  ├─ proxmox/                 # Proxmox VE API-client, ticket/token-auth, TLS-pinning
│  ├─ remote-exec/             # SSH (ssh2) + WinRM executors, CommandSpec-register
│  ├─ automation/              # playbook-engine, stapregister, guards, herstelacties
│  ├─ providers-virt/          # migratie-bronadapters: vmware, hyperv
│  ├─ i18n/                    # glossary.csv, locales/{en,nl}.json, loader, CI-validators
│  └─ config/                  # env-schema + getypeerde configloader (zod), voor alle apps
├─ deploy/
│  ├─ compose/                 # docker-compose.yml, .prod.yml, .dev.yml
│  ├─ caddy/                   # Caddyfile-templates
│  └─ systemd/                 # velnox.service unit voor appliance-installaties
├─ scripts/
│  ├─ build.sh  build-tar.sh  build-iso.sh  build-dev.sh
│  └─ lib/                     # gedeelde shellfuncties (logging, preflight, docker-installatie)
├─ iso/                        # live-build configuratie: hooks, preseed, pakketlijsten
├─ docs/                       # deze map
├─ install.sh
├─ uninstall.sh
├─ .env.example
└─ turbo.json  pnpm-workspace.yaml  package.json
```

**Regel:** `apps/*` bevatten bedrading en transport. Alle herbruikbare domeinlogica staat in
`packages/*`, zodat api, worker en tests dezelfde code importeren. Geen bestand boven circa 400
regels; een playbook, een herstelactie en een adapter krijgen elk hun eigen bestand.

---

## 4. Requestverloop en de autorisatielagen

Elke geauthenticeerde request bouwt een `RequestContext` in `AsyncLocalStorage`:

```ts
interface RequestContext {
  userId: string;
  sessionId: string;
  isMspRoot: boolean;            // lid van de MSP-hoofdtenant
  homeTenantId: string;
  grants: Grant[];               // { permission, scopeType, scopeId }
  accessibleTenantIds: string[]; // vooraf herleid; '*'-semantiek voor MSP root
  ip: string; userAgent: string;
}
```

**Laag 1 — expliciete autorisatie.** Een decorator `@RequirePermission('nodes.manage')` plus een
*scope resolver* die de request naar een concreet bereik herleidt (node → cluster → locatie → tenant)
en aan de `AuthorizationService` vraagt of een toekenning dat recht op of boven dat bereik dekt.
Weigeringen worden geaudit.

**Laag 2 — verplichte query-afbakening.** Een Prisma client-extensie onderschept elke query op een
tenant-gebonden model en injecteert `tenantId IN (...)`. Zij gooit een fout wanneer een tenant-gebonden
model wordt bevraagd zonder `RequestContext`, tenzij de aanroeper expliciet en doorzoekbaar
`withSystemScope()` gebruikt (alleen door workers, migraties en de installatiewizard). *Vergeten* van
een autorisatiecontrole lekt daardoor niets; je moet er actief omheen werken.

**Ruwe SQL is verboden** in applicatiecode via een ESLint-regel (`no-restricted-properties` op
`$queryRaw`/`$executeRaw`) met een gedocumenteerde uitzonderingslijst, omdat ruwe SQL laag 2 omzeilt.

**Laag 3 (gepland, hardening in Phase 15):** PostgreSQL Row-Level Security op de meest risicovolle
tabellen (`credentials`, `nodes`, `vms`, `audit_events`, `jobs`), aangestuurd door
`SET LOCAL velnox.tenant_ids` binnen een interactieve transactie. Uitgesteld omdat het elke query in
een expliciete transactie dwingt en connection pooling compliceert; vastgelegd als bekende beperking in
plaats van stilzwijgend overgeslagen.

---

## 5. Authenticatieontwerp

| Onderwerp | Keuze |
|---|---|
| Wachtwoordhashing | Argon2id, m=64 MiB, t=3, p=4, 32-byte uitvoer, willekeurige salt per gebruiker |
| Sessietransport | `HttpOnly; Secure; SameSite=Lax`-cookie, same-origin via de BFF |
| Access token | JWT (HS256, `JWT_SECRET`), TTL 15 min, bevat `sub`, `sid`, `ver` |
| Refresh token | Ondoorzichtig, 256 bits, **gehasht** opgeslagen (SHA-256) in `sessions`, TTL 8 u glijdend, geroteerd bij elk gebruik, met **hergebruikdetectie** die de hele sessiefamilie intrekt |
| Intrekken | `sessions.revoked_at` plus een `ver`-teller op de gebruiker; een JWT met verouderde `ver` wordt geweigerd |
| CSRF | Double-submit token in een niet-`HttpOnly`-cookie plus header `X-Velnox-CSRF`, verplicht bij elke niet-GET-request |
| MFA | **Optioneel, aanbevolen, standaard uit.** TOTP (RFC 6238, 30 s, SHA-1 voor compatibiliteit met authenticator-apps, ±1 venster drift) plus 10 eenmalige herstelcodes, Argon2id-gehasht. De TOTP-seed staat in de credential store, nooit als platte kolom. WebAuthn is voorzien maar uitgesteld. |
| MFA-beleid | Per installatie en per tenant: `OPTIONAL` (standaard) \| `REQUIRED_FOR_PRIVILEGED` \| `REQUIRED`. `REQUIRED_FOR_PRIVILEGED` geldt voor elke gebruiker met een `*.manage`-, `*.execute`- of `credentials.rotate`-recht op enig bereik — precies de accounts die klantinfrastructuur kunnen wijzigen. |
| MFA-afdwinging | `sessions.mfa_satisfied_at`; een sessie die niet aan MFA voldeed bereikt alleen de aanmeldstroom en uitloggen. Afgedwongen door een globale guard, zodat een nieuw endpoint standaard gedekt is. |
| Brute force | Limieten per account en per IP met exponentiële vertraging; blokkade is *zacht* (vertraging) om triviale account-DoS te voorkomen. MFA- en herstelcodepogingen hebben een eigen, strengere limiet. |
| SSO | Microsoft Entra ID, OIDC authorization code + PKCE; `state`/`nonce` in Redis met TTL van 10 min |
| Noodtoegang | Lokale beheerderslogin kan nooit door SSO-configuratie worden uitgeschakeld; volledig uitschakelen vereist minstens één andere MSP Super Administrator met een geverifieerd lokaal wachtwoord |
| Machinetoegang | Afgebakende API-tokens (`velnox_pat_<id>_<secret>`), gehasht opgeslagen, eigen rechtenset, eigen actortype in de audit |

**Installatiewizard:** de API biedt `GET /api/v1/setup/status`. Zolang `system_settings.initialized`
onwaar is, staat precies één muterend endpoint open — `POST /api/v1/setup/initialize` — dat de
MSP-hoofdtenant, de systeemrollen en de eerste Super Administrator aanmaakt en `initialized` omzet,
binnen één databasetransactie. Daarna geeft het permanent `409 Conflict`. Er bestaat op geen enkel
moment een standaardaccount of standaardwachtwoord.

---

## 6. RBAC-model

Rechten zijn tekstwaarden (`resource.action`), één keer gedefinieerd in
`packages/shared/permissions.ts` als vaste catalogus — de enige bron van waarheid voor API-guards,
seed-data en de UI.

Rollen zijn **benoemde bundels rechten**. Systeemrollen (MSP Super Administrator, MSP Administrator,
MSP Engineer, MSP Read Only, Tenant Administrator, Tenant Operator, Tenant Read Only) zijn geseed en
onveranderlijk; eigen rollen per tenant komen uit dezelfde catalogus.

Autorisatie wordt beoordeeld op een **toekenning** = (rol, bereik):

```
RoleAssignment: gebruiker × rol × bereik
bereik ∈ { GLOBAL, TENANT:<id>, SITE:<id>, CLUSTER:<id> }
```

`GLOBAL` is uitsluitend toekenbaar aan leden van de MSP-hoofdtenant en alleen door een Super
Administrator. Een toekenning op `TENANT:A` impliceert zeggenschap over elke locatie, cluster, node en
workload onder tenant A. Een toekenning op `CLUSTER:X` autoriseert alleen de nodes en workloads van dat
cluster — dit maakt "MSP-engineer die alleen het DR-cluster van klant B mag aanraken" uitdrukbaar.

De afweging luidt: *heeft de gebruiker een toekenning met recht P waarvan het bereik een voorouder is
van (of gelijk aan) het bereik van het doel?* De bereikhiërarchie van elke resource staat op de rij zelf
(`tenant_id`, `site_id`, `cluster_id`), waardoor dit een goedkope controle is en geen recursieve
doorloop.

---

## 7. Secrets en credentialbeheer

```
MASTER_ENCRYPTION_KEY (32 bytes, base64, uit env of secret-bestand)
        │  HKDF-SHA256, info="velnox/kek/v1"
        ▼
      KEK  ──AES-256-GCM──►  gewrapte DEK   (per credential, willekeurig 32 bytes)
                                  │
                                  ▼
                       AES-256-GCM(secretmateriaal)
                       opgeslagen: ciphertext ‖ iv ‖ authTag ‖ key_version
```

Envelope-encryptie (in plaats van directe encryptie) is gekozen omdat rotatie van de hoofdsleutel dan
alleen DEK's herwrapt — secretmateriaal hoeft nooit ontsleuteld en opnieuw versleuteld te worden — en
omdat het een schone aansluiting geeft voor een toekomstige KMS die DEK's op afstand wrapt.

`SecretStore` is een interface — `put`, `get`, `delete`, `rewrap` — met `DatabaseSecretStore` als
v1-implementatie en `VaultSecretStore` / `AzureKeyVaultSecretStore` als gedocumenteerde toekomstige
backends. **Alleen de worker roept ooit `get()` aan.** De API kan credentials aanmaken en ernaar
verwijzen, maar heeft geen code path dat platte tekst teruggeeft.

### Redactie

- Een pino-redactieserializer verwijdert bekende sleutels met secretmateriaal, en een laatste sweep
  maskeert alles wat overeenkomt met opgeslagen secretwaarden voordat een logregel of jobgebeurtenis
  wordt opgeslagen.
- Secrets worden nooit als procesargument meegegeven (zichtbaar in `ps`). Wachtwoordwijzigingen gaan
  door `root:<wachtwoord>\n` naar de **stdin van een remote `chpasswd`** over het SSH-kanaal te
  schrijven.
- `JobEvent`-payloads zijn getypeerd; een stap geeft gestructureerde data terug, nooit ruwe
  commando-uitvoer die een secret zou kunnen echoën. Ruwe uitvoer gaat naar een in omvang begrensde,
  geredigeerde `JobLog`.

### Rotatievolgorde (crashbestendig)

1. Genereer het nieuwe wachtwoord in het geheugen.
2. Sla het versleuteld op met status `PENDING` — **vóór** het toe te passen. Een crash na stap 3 mag
   nooit een node achterlaten met een wachtwoord dat Velnox niet kent.
3. Pas het toe via `chpasswd` over SSH.
4. Open een *nieuwe* verbinding en authenticeer met het nieuwe wachtwoord.
5. Bij succes: markeer het nieuwe secret `ACTIVE` en het oude `SUPERSEDED` (bewaard gedurende een
   instelbare respijtperiode). Bij mislukking: bewaar beide, markeer het credential
   `NEEDS_ATTENTION`, geef een melding en verwijder niets.

---

## 8. Proxmox-integratie

`packages/proxmox` omhult de PVE-API (`https://<host>:8006/api2/json`).

- **Authenticatie:** API-token (`Authorization: PVEAPIToken=user@realm!tokenid=uuid`) heeft de
  voorkeur; ticket-authenticatie (`POST /access/ticket` → cookie + `CSRFPreventionToken`) wordt
  ondersteund waar geen token gebruikt kan worden. Tickets worden in Redis gecachet tot 10 minuten
  vóór verval.
- **TLS:** Proxmox levert self-signed certificaten. Velnox gebruikt nooit een generieke
  `rejectUnauthorized: false`. Bij het toevoegen van een endpoint wordt de vingerafdruk getoond en moet
  die bevestigd worden (trust-on-first-use); de SHA-256-vingerafdruk wordt op de rij vastgelegd en bij
  elke volgende verbinding geverifieerd. Een gewijzigde vingerafdruk laat de verbinding falen en geeft
  een melding. Een eigen CA-bundel kan als alternatief worden gebruikt.
- **Leespad:** `/cluster/status`, `/cluster/resources`, `/nodes`, `/nodes/{n}/status`,
  `/nodes/{n}/version`, `/nodes/{n}/apt/update`, `/nodes/{n}/apt/repositories`,
  `/nodes/{n}/subscription`, `/nodes/{n}/network`, `/storage`, `/cluster/ceph/status`.
- **Taakpad:** PVE geeft een UPID terug bij langlopende operaties; de client pollt
  `/nodes/{n}/tasks/{upid}/status` en streamt `/log` naar de Velnox-jobgebeurtenissenstroom.
- **Snelheid/gelijktijdigheid:** limiet per endpoint, herhaalpogingen met jitter bij 5xx en
  PVE-responses 595/596.

`packages/remote-exec` dekt wat de API niet kan (`apt dist-upgrade`, `pve8to9`, `chpasswd`, aanpassen
van repositorybestanden):

- SSH via `ssh2`, waar mogelijk op sleutelbasis, anders met een wachtwoord uit de secret store.
- **Verificatie van de hostsleutel is verplicht:** TOFU bij eerste verbinding met expliciete bevestiging
  door de operator, daarna vastgelegd; een afwijking is een harde fout plus een melding.
- Commando's zijn **`CommandSpec`-objecten uit een register**, geen teksten uit HTTP. Een spec legt het
  argv-sjabloon vast, of het alleen-lezen is, de timeout, de parser en het vereiste recht. Geen enkel
  endpoint accepteert een uit te voeren commando.

---

## 9. Jobsysteem en de playbook-engine

```
POST /api/v1/…/jobs ──► Job-rij (QUEUED) ──► BullMQ enqueue
                                                   │
                                            worker pakt op
                                                   │
                            ┌──────────────────────┴───────────────────┐
                            │  PlaybookRunner                          │
                            │   voor fase in playbook.phases:          │
                            │     voor stap in fase.steps:             │
                            │       evalueer guards ──► eventueel STOP │
                            │       controleer annuleringsvlag         │
                            │       voer uit (idempotent)              │
                            │       zend JobEvent ──► Redis pub/sub ───┼──► SSE ──► UI
                            │       leg JobStep-resultaat vast         │
                            └──────────────────────────────────────────┘
```

**Jobstatussen:** `queued → preflight → waiting_approval → running → validating →
{succeeded | partially_succeeded | failed | rolled_back | cancelled}`. Overgangen worden door een
toestandsmachine afgedwongen; een ongeldige overgang gooit een fout.

**Playbooks zijn data.** Een playbook is een geversioneerd object met fasen en stapverwijzingen; de
stappen komen uit een `StepRegistry` van kleine, getypeerde, idempotente implementaties. De upgrade van
PVE 8 → 9 is één playbook; een toekomstige PVE 9 → 10 of een PBS-upgrade is een ander playbook dat
dezelfde stappen hergebruikt. Er staat geen workflowlogica hardgecodeerd in één grote functie.

**Guards** zijn declaratieve voorwaarden die tussen stappen worden geëvalueerd — clusterquorum,
Ceph-gezondheid, nodecapaciteit, migreerbaarheid van workloads, gelijktijdigheidslimiet. Een guard geeft
`PASS | WARN | BLOCK`; `BLOCK` stopt de uitvoering (of die tak) en legt vast welke guard afging.

**Rolling updates** zijn een fan-out playbook met een gelijktijdigheidslimiet op clusterniveau. De
veiligheidsinvariant wordt centraal afgedwongen, niet per stap: *op geen enkel moment mag het aantal
gelijktijdig niet-beschikbare stemmende nodes groter zijn dan `⌊(n-1)/2⌋`*; standaard is de
gelijktijdigheid 1; en de uitvoering weigert te starten wanneer het cluster al verminderd is.

**Annuleren** zet een vlag in Redis; de runner controleert die bij elke stapgrens en binnen
langlopende wachtlussen via een `AbortSignal`. Een lopende stap mag afronden of terugdraaien — Velnox
breekt nooit een `dist-upgrade` halverwege af.

**Goedkeuringspunten** zijn stappen die een `Approval`-rij vastleggen en de job in
`waiting_approval` parkeren. Hervatten vereist het relevante recht en, wanneer het vierogenprincipe in
het beleid staat, een *andere* persoon dan degene die de job indiende.

---

## 10. Major upgrade- en herstelactieframework

Zeven fasen, zoals gespecificeerd: Discovery → Preflight → Herstelplan → Hercontrole → Upgrade →
Validatie na upgrade → Rapport.

De uitvoer van `pve8to9` wordt geparseerd naar gestructureerde `UpgradeCheck`-rijen:

| Proxmox-uitvoer | Velnox-ernst |
|---|---|
| `PASS` | `PASS` |
| `INFO` / `SKIP` | `INFO` |
| `WARN` | `WARNING` |
| `FAIL` | `BLOCKER` |
| niet-herkende regel | `UNKNOWN` → **behandeld als blokkade die menselijke beoordeling vereist** |

Veilig falen bij `UNKNOWN` is bewust: Proxmox wijzigt dit hulpmiddel tussen point releases, en een
parser die een onbekende regel stilzwijgend laat vallen zou een echte blokkade doorlaten. De parser is
geversioneerd en de ruwe uitvoer wordt altijd naast de parse bewaard.

**Herstelactie-plugins** implementeren:

```ts
interface Remediation {
  id: string; name: string; description: string;
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
  automaticSafe: boolean;        // mag zonder mens draaien
  requiresApproval: boolean;
  matches(check: UpgradeCheck, ctx: NodeContext): boolean;
  preconditions(ctx): Promise<GuardResult>;
  plan(ctx): Promise<ChangeSet>;   // exacte diff, getoond vóór er iets draait
  apply(ctx): Promise<void>;       // idempotent
  validate(ctx): Promise<GuardResult>;
  rollback(ctx): Promise<void>;
}
```

`automaticSafe` wordt alleen toegekend wanneer de wijziging idempotent is, er een back-up van de
geraakte bestanden bestaat en `validate()` het resultaat positief kan bevestigen. Al het overige —
alles wat opslag, netwerk of niet-Proxmox-pakketten raakt — stopt voor goedkeuring en toont de operator
de exacte wijzigingsset. Elke herstelactie schrijft een auditgebeurtenis met de diff vóór en na.

### 10.1 Ceph major upgrades

Ceph-upgrades zijn **in scope voor v1** en vormen het tweede concrete playbook op de generieke engine —
wat meteen het bewijs van genericiteit levert: dezelfde runner, hetzelfde stapregister en dezelfde
guard-evaluator sturen zowel een Debian/PVE major upgrade als een Ceph-release-upgrade aan, zonder iets
Ceph-specifieks in de engine zelf.

**Waarom dit geen stap binnen de PVE-upgrade kan zijn.** Een Proxmox major upgrade overschrijdt een
Debian-release; een Ceph-release-upgrade is een rollende herstart van daemons over het hele cluster. Ze
hebben verschillende werkeenheden (node versus daemon), verschillende gezondheidsmodellen
(corosync-quorum versus Ceph `HEALTH_OK` plus PG-status) en verschillende faalwijzen. Velnox modelleert
ze als **afzonderlijke playbooks die een plan achtereenvolgens samenstelt.**

**Volgorde.** Een PVE major release levert een specifieke Ceph-release en ondersteunt de vorige niet.
Een upgradeplan voor een Ceph-cluster wordt daarom samengesteld als:

```
UpgradePlan(kind = COMPOSITE)
  └─ 1. ceph-upgrade playbook   (eerst, nog op de huidige PVE/Debian-release)
  └─ 2. pve-major-upgrade playbook  (node voor node, rollend)
```

De samenstelling en de exacte bron → doel releaseparen komen uit een **versiematrix-databestand**, niet
uit code — en de matrix wordt tijdens de uitvoering *geverifieerd tegen de live node* in plaats van
vertrouwd. Wanneer de draaiende Ceph-release, de doel-PVE-release en de matrix niet overeenkomen,
weigert het plan te bouwen en benoemt het precies welke van de drie onverwacht is. Dezelfde veilige
houding als bij de `pve8to9`-parser: Velnox gokt nooit over versiecompatibiliteit.

**Daemonvolgorde binnen één Ceph-release-upgrade** volgt de gedocumenteerde Ceph-sequentie, waarbij elke
fase voltooid en opnieuw gevalideerd is voordat de volgende begint:

```
repositories op alle nodes  →  noout zetten
  →  MON   (één tegelijk; wacht na elke op volledig mon-quorum)
  →  MGR   (wacht op een actieve mgr)
  →  OSD   (per node; wacht na elke node op HEALTH_OK en alle PG's active+clean)
  →  MDS   (eerst terugbrengen naar één actieve rank waar CephFS aanwezig is)
  →  RGW   (indien aanwezig)
  →  require-osd-release verhogen  →  noout opheffen  →  daemonversies homogeen verifiëren
```

**Guards, geëvalueerd vóór de uitvoering en opnieuw vóór elke daemongroep:**
Ceph meldt `HEALTH_OK`; alle PG's `active+clean`; geen backfill of recovery bezig; volledig
MON-quorum; geen OSD's `out` of `down`; genoeg vrije capaciteit om de OSD's van één node te missen op
het ingestelde failure domain; en `ceph versions` homogeen — een cluster dat al middenin een upgrade
zit is een blokkade, niet iets om "door te zetten".

**Harde regels.** `noout` wordt altijd opgeheven in een opruimstap die op elk pad draait, ook bij
annulering en mislukking — een cluster met `noout` laten staan is een stille tijdbom.
`require-osd-release` wordt pas verhoogd wanneer elke OSD de doelrelease meldt. Annuleren stopt op een
daemongrens, nooit halverwege een herstart. En Velnox gaat nooit door naar de volgende daemongroep bij
een `HEALTH_WARN` die het niet herkent: onbekende gezondheidsstatussen zijn blokkades.

**Clusters zonder Ceph** slaan dit alles over; de samenstellingsstap doet niets wanneer geen Ceph is
gedetecteerd.

---

## 11. Migratieframework

Eén framework, twee bronadapters:

```ts
interface MigrationSourceAdapter {
  kind: 'vmware' | 'hyperv';
  testConnection(): Promise<ConnectionResult>;
  discoverHosts(): Promise<SourceHost[]>;
  discoverWorkloads(): Promise<SourceWorkload[]>;   // cpu, ram, disks, nics, firmware, power
  assessCompatibility(w: SourceWorkload, target: TargetSpec): CompatibilityReport;
  buildPlan(w: SourceWorkload, target: TargetSpec): MigrationPlan;
}
```

- **VMware:** vCenter REST (`/api/vcenter/…`) waar een vCenter bestaat; standalone ESXi via de host-API.
  Voor de daadwerkelijke schijfoverdracht orkestreert Velnox **de eigen ESXi-import storage van Proxmox
  VE** (PVE ≥ 8.2) in plaats van dit opnieuw te implementeren — het ondersteunde, eerlijke pad. Clusters
  onder 8.2 krijgen discovery, een plan en een gedocumenteerde handmatige procedure, geen nepknop.
- **Hyper-V:** er is geen REST-API. Discovery draait alleen-lezen PowerShell (`Get-VM`, `Get-VHD`,
  `Get-VMNetworkAdapter`) over WinRM. Schijfconversie is `qemu-img convert` vanaf VHDX, wat vereist dat
  de VHDX bereikbaar is voor een door Velnox gestuurde overdrachtsstap (SMB of SSH). In v1 is die stap
  met handmatige tussenkomst en wordt dat als zodanig in de UI aangegeven.

`assessCompatibility` is een volwaardige uitkomst, geen bijzaak: UEFI/Secure Boot, vTPM,
independent/RDM-schijven, bestaande snapshots, PVSCSI/VMXNET3-stuurprogramma's, VM-generatie, dynamisch
geheugen en cluster-gedeelde opslag leveren allemaal expliciete waarschuwingen op. De wizard suggereert
nooit een verliesvrije één-op-één-conversie.

---

## 12. Frontendarchitectuur

Next.js App Router, TypeScript, Tailwind, shadcn/ui (Radix-primitieven), TanStack Query en Table,
`next-themes` voor donkere modus. Server Components voor de shell en de eerste data; Client Components
voor tabellen, detailpanelen en live jobstromen.

- De browser krijgt nooit een bearer token te zien. Pagina's lezen via Server Components over het
  interne Docker-netwerk; de enkele client-side aanroepen gaan naar `/api/v1/*` op **dezelfde origin**,
  die Caddy naar de API routeert.

  > **Gewijzigd in fase 1.** Fase 0 schreef een Next.js-proxyroute voor (`app/api/[...proxy]`) om de
  > API van de publieke origin te houden. Dat bleek niets op te leveren: machineclients hebben hoe dan
  > ook API-tokens tegen een bereikbare API nodig (§5), dus de API is sowieso publiek, en Caddy maakt
  > hem al same-origin — en dát is wat CORS wegneemt en de sessiecookie `HttpOnly` houdt. De proxy zou
  > een extra hop en een tweede code path zijn geweest zonder winst in veiligheid, dus is hij niet
  > gebouwd. Het pakket `server-only` bewaakt `lib/api.ts`, zodat het interne adres niet per ongeluk in
  > een Client Component kan belanden.
- Rechten worden eenmaal per sessie in een context geladen; de UI *verbergt* wat een gebruiker niet mag,
  maar dat is cosmetisch — de server beslist en geeft hoe dan ook 403.
- Live jobvoortgang loopt via een `EventSource` op `/api/v1/jobs/:id/stream`, met automatisch
  herverbinden en polling als terugval.
- Visuele taal: dichte tabellen, gedempte neutrale vlakken, uitsluitend semantische statuskleuren
  (ok / waarschuwing / fout / onbekend), geen kleurverlopen, geen glassmorphism, geen marketinganimatie.
  Indeling en navigatie exact zoals in de opdracht beschreven.

---

## 13. Deployment

Zes Compose-services: `caddy`, `web`, `api`, `worker`, `postgres`, `redis`. `api` en `worker` zijn
**hetzelfde image** met verschillende entrypoints — één build, twee rollen.

- Health checks op elke service; `depends_on: condition: service_healthy`.
- `postgres` en `redis` staan op een intern netwerk **zonder gepubliceerde poorten**.
- Named volumes `velnox_pgdata`, `velnox_redisdata`, `velnox_caddydata`.
- Migraties draaien in een eenmalige `migrate`-service die met code 0 moet eindigen voordat `api` start
  — nooit tijdens het opstarten van api, wat over meerdere replica's een race zou zijn.
- Secrets worden door `install.sh` in `.env` gegenereerd (modus 0600) en, waar ondersteund, gekoppeld
  als Docker secrets-bestanden met `*_FILE`-indirectie.
- `install.sh` is idempotent: het behoudt een bestaande `.env`, installeert Docker alleen wanneer die
  ontbreekt, en voert migraties veilig opnieuw uit.
- **Air-gapped installatie is het standaardartefact.** `build.sh --target tar` bundelt met
  `docker save` opgeslagen images naast de compose-bestanden en de installer, zodat een schone
  Debian-host geen registry-toegang nodig heeft — het doet `docker load` en start. Dat kost ruwweg 1 GB
  aan artefactomvang, wat de juiste afweging is voor een appliance die binnen klantnetwerken wordt
  geïnstalleerd, waar uitgaande toegang tot een registry vaak juist de blokkade vormt. Een `--slim`-
  variant die uit een registry haalt wordt daarnaast geproduceerd. Docker zelf wordt nog steeds uit de
  Debian-/Docker-repositories geïnstalleerd wanneer het ontbreekt; een volledig offline installatie
  vereist bovendien dat Docker al aanwezig is, en de installer zegt dat expliciet vooraf in plaats van
  halverwege te falen.

---

## 14. Waarneembaarheid en beheer

- Gestructureerde JSON-logging (pino) met request-id-correlatie en verplichte redactie.
- `/healthz` (leeft) en `/readyz` (database en Redis bereikbaar, migraties actueel).
- Optionele `/metrics` in Prometheus-formaat: wachtrijdiepte, jobduur, API-latentie, foutpercentages van
  adapters. Standaard uit, aan te zetten via env.
- Back-up: een gedocumenteerde procedure met `pg_dump` plus `.env`. **Het kwijtraken van
  `MASTER_ENCRYPTION_KEY` maakt elk opgeslagen credential onherstelbaar** — nadrukkelijk vermeld in de
  installeruitvoer, de README en de back-updocumentatie.

---

## 15. Licentie, lokalisatie en merknaam

### AGPLv3 — en de producteis die daaruit volgt

Velnox valt onder de **GNU Affero General Public License, versie 3**. Artikel 13 is voor
netwerk-benaderde software geen papieren formaliteit: wie een *aangepaste* Velnox via een netwerk
gebruikt, moet de bijbehorende broncode van die versie aangeboden krijgen.

Dat is dus een **functie met acceptatiecriteria**, geen bestand in de repository-root:

- `GET /api/v1/system/source` geeft de versie, de build-commit, het buildtijdstip en de bron-URL van de
  draaiende build.
- **Instellingen → Over** toont hetzelfde, met een zichtbare link, bereikbaar voor elke ingelogde
  gebruiker — niet alleen beheerders.
- De bron-URL is een buildvariabele (`VELNOX_SOURCE_URL`) die standaard naar de upstream-repository
  wijst. Een operator met een aangepaste build zet die naar de eigen broncode. De build sluit de
  git-commit in, zodat de claim verifieerbaar is.
- `THIRD-PARTY-NOTICES.md` wordt tijdens de build uit het lockfile gegenereerd en in elk artefact
  meegeleverd.

De keuze voor AGPL boven GPL is voor dit product bewust: Velnox is precies het soort software dat
iemand anders als gesloten gehoste dienst zou draaien, en de AGPL houdt verbeteringen terugvloeien. Zie
[tech-decisions.md](tech-decisions.md) ADR-020.

### Lokalisatie

Engels en Nederlands zitten in v1, gebouwd op een vaste woordenlijst (`packages/i18n/glossary.csv`),
zodat een derde taal een datawijziging is in plaats van een codewijziging. De leidende regel —
**geen enkele zichtbare tekst staat in applicatiecode** — moet vanaf de eerste commit gelden, en is
daarom een architectuurbeperking en geen polijstpunt voor Phase 13. Auditgebeurtenissen,
jobgebeurtenissen en logs blijven bewust Engels; het zijn forensische vastleggingen. Volledig ontwerp:
[i18n.md](i18n.md).

### Merknaam

De productnaam komt uit `system_settings.product_name` en wordt als `{product}` geïnterpoleerd in elke
berichtcatalogus; logo's en kleurtokens staan in één assetmodule. Het product hernoemen is een
instellingswijziging plus een assetwissel — geen codewijziging — wat zowel aan de modulariteitseis uit
de opdracht voldoet als aan het handelsmerkstandpunt in [TRADEMARK.md](../../TRADEMARK.md): een fork
kan schoon van merknaam wisselen en wordt geacht dat te doen.

---

*Velnox™ en het Velnox-logo zijn handelsmerken van The Velnox Foundation.
Velnox is vrije software onder de AGPLv3; de licentie verleent geen rechten op handelsmerken.*

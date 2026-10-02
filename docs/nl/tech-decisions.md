# Velnox — Technologiekeuzes (ADR-log)

> **Vertaling.** Bron: [docs/tech-decisions.md](../tech-decisions.md) @ `2c5fd66`.
> **Engels is leidend.** Bij verschil tussen deze tekst en de Engelse versie geldt de Engelse tekst.

**Status:** Phase 0. Deze keuzes zijn voorstellen in afwachting van goedkeuring; er is nog niets
geïmplementeerd. Elke ADR benoemt de keuze, de overwogen alternatieven, en waarom die afvielen.

---

## ADR-001 — Monorepo met pnpm workspaces + Turborepo

**Keuze:** één repository, `pnpm` workspaces, Turborepo voor taakorkestratie en caching.

**Alternatieven:** npm/yarn workspaces (tragere installaties, geen strikte node_modules-isolatie); Nx
(krachtiger, maar zwaarder qua concepten dan dit project nodig heeft); polyrepo (afgevallen — api en
worker moeten domeincode en de Prisma-client delen, en versieverschil daartussen zou een
correctheidsfout zijn, geen ongemak).

**Gevolg:** api, worker, web en alle packages delen één TypeScript-basisconfiguratie, één
ESLint-configuratie, één lockfile en één `pnpm build` die incrementeel gecachet wordt.

---

## ADR-002 — NestJS voor de backend

**Keuze:** NestJS 11 op Node 22 LTS.

**Waarom:** de eisenlijst is in feite een opsomming van NestJS-sterktes — guards voor RBAC,
interceptors voor audit en redactie, modules voor servicegrenzen, DI voor de adapterregisters,
eersteklas BullMQ- en OpenAPI-integratie, en een testaanpak die RBAC- en tenant-isolatietests
eenvoudig maakt.

**Alternatieven:** Fastify met eigen structuur (sneller te starten, maar dan bouwen we DI, guards en
modulegrenzen zelf); Express (te weinig structuur voor een project van deze omvang); Go/Rust (betere
ruwe prestaties, maar deze belasting is I/O-gebonden orkestratie, en TypeScript van voor tot achter
laat de frontend dezelfde zod-contracten importeren).

---

## ADR-003 — Next.js App Router voor de frontend, gebruikt als BFF

**Keuze:** Next.js 16, App Router, TypeScript, Tailwind, shadcn/ui.

**Waarom BFF:** de browser houdt geen token vast. Sessiecookies blijven `HttpOnly` en same-origin, en
pagina's lezen de API vanuit Server Components over het interne Docker-netwerk.

**Gewijzigd in fase 1 — geen proxyroute.** Het oorspronkelijke plan voegde Next route handlers toe die
`/api/v1/*` proxyden. Caddy serveert de API al op dezelfde origin, en dát is wat CORS wegneemt en de
`HttpOnly`-cookie laat werken; bovendien was de API van de publieke origin houden nooit haalbaar,
omdat machineclients API-tokens tegen een bereikbare API nodig hebben. De proxy zou een extra hop en
een tweede code path zijn geweest zonder winst in veiligheid, dus is hij geschrapt. `lib/api.ts` is
gemarkeerd als `server-only`, wat een onbedoelde import vanuit een Client Component tot een buildfout
maakt.

**Gewijzigd in fase 5 — Next.js 15.5 → 16.3.** Een major-versie, en er veranderde minder dan dat doet
vermoeden, omdat de code al stond waar 16 op aandringt: elke `params` en `searchParams` werd al
ge-await, er is geen middleware om naar `proxy` te hernoemen, en niets gebruikte de caching- of
image-API's die veranderden. Wat wel veranderde:

- **next-intl moest van 3 naar 4.** 3.x noemt Next 15 als bovengrens. Er kwam één typefout mee: 4
  typeert de sleutel voor `t()` strikt, en een opzoeking in een `Record<string, string>` is
  `string | undefined`, ook na een controle op dezelfde expressie. Opgelost door hem eerst in een
  variabele te lezen.
- **next-intl 4 brengt twee packages met installatiescripts mee**, `@swc/core` en `@parcel/watcher`,
  allebei voor een berichtenextractor die Velnox niet gebruikt. Beide zijn geweigerd in
  `pnpm-workspace.yaml`, met de reden erbij — dezelfde redenering als bij `msgpackr-extract`.
- **De `eslint`-sleutel in `next.config.ts` is weg**, omdat `next build` niet meer lint. De sleutel
  bestond alleen om dat te voorkomen.
- **`next build` gebruikt standaard Turbopack.** Er was geen configuratie nodig; de build en de
  standalone-uitvoer werkten zoals ze waren.

**Alternatieven:** Vite-SPA met directe API-aanroepen (vereist CORS en een token dat voor JavaScript
bereikbaar is, of cookieafhandeling over origins heen); Remix (prima, maar een kleiner ecosysteem voor
de gewenste componentbibliotheek).

---

## ADR-004 — PostgreSQL 16 + Prisma

**Keuze:** PostgreSQL 16 als enige persistente opslag; Prisma als ORM en migratiehulpmiddel.

**Waarom Prisma:** een getypeerde client die api en worker delen; een volwassen migratieproces
(`prisma migrate deploy` in een eenmalige container); en, doorslaggevend, **client extensions**, die
één plek geven om tenant-afbakening op elke query af te dwingen.

**Aanvaarde afweging:** de ruwe-SQL-uitweg van Prisma omzeilt die extensie. Ondervangen door een
ESLint-verbod op `$queryRaw`/`$executeRaw` buiten een uitzonderingslijst, en door
tenant-isolatietests.

**Alternatieven:** Drizzle (lichter, betere ruwe SQL, maar geen equivalent van globale
query-onderschepping); TypeORM (zwakkere typering en migratie-ergonomie die we niet op een security
boundary willen).

---

## ADR-005 — Redis + BullMQ voor de wachtrij, PostgreSQL voor jobwaarheid

**Keuze:** BullMQ op Redis 7 voor planning en uitvoering; een `jobs`-tabel in PostgreSQL als bron van
waarheid voor status, stappen, gebeurtenissen en goedkeuringen.

**Waarom beide:** Redis geeft herhaalpogingen, uitgestelde jobs, herhaalbare (cron)jobs,
gelijktijdigheidslimieten en pub/sub voor live voortgang. Maar jobhistorie, goedkeuringsbeslissingen en
auditsporen zijn verantwoordingsdocumenten en moeten een Redis-flush overleven. Bij het starten van de
worker vergelijkt een verzoener beide en zet weesjobs opnieuw in de wachtrij of laat ze falen.

**Alternatieven:** alleen PostgreSQL als wachtrij (pg-boss / SKIP LOCKED) — één service minder, maar
zwakkere planningsprimitieven en geen pub/sub voor SSE; Temporal (uitstekend passend bij de
workflowsemantiek, maar voegt een heel cluster toe aan een self-hosted appliance — afgevallen op
operationele zwaarte).

---

## ADR-006 — SSE in plaats van WebSockets voor live jobvoortgang

**Keuze:** Server-Sent Events op `GET /api/v1/jobs/:id/stream`, gevoed door Redis pub/sub.

**Waarom:** voortgang gaat uitsluitend van server naar client. SSE hergebruikt de bestaande
cookie-authenticatie en de HTTP-middlewarestapel (inclusief de RBAC-guard), overleeft reverse proxies
zonder upgrade-dans, en herverbindt vanzelf. WebSockets zouden een parallel authenticatiepad vereisen —
precies het soort tweede deur dat autorisatiegaten oplevert.

---

## ADR-007 — Argon2id, JWT access token, ondoorzichtig roterend refresh token

**Keuze:** zoals beschreven in [architecture.md](architecture.md#5-authenticatieontwerp).

**Waarom geen langlevende JWT's alleen:** die kunnen niet ingetrokken worden. Voor een hulpmiddel dat
root-credentials van hypervisors bewaart, is directe sessie-intrekking verplicht. Korte access tokens
plus een server-side refresh-record geven intrekbaarheid zonder databaselezing bij elke request.

**Waarom geen pure server-side sessies:** ook acceptabel; de hybride houdt het hete pad staatloos en
behoudt intrekbaarheid. `JWT_SECRET` maakt bovendien al deel uit van de vereiste configuratie.

---

## ADR-008 — Envelope-encryptie met een vervangbare SecretStore

**Keuze:** AES-256-GCM DEK per secret, gewrapt door een KEK afgeleid van `MASTER_ENCRYPTION_KEY` via
HKDF-SHA256, achter een `SecretStore`-interface.

**Waarom:** rotatie van de hoofdsleutel herwrapt alleen DEK's. Een toekomstige Vault- of Azure Key
Vault-backend vervangt de wrap-stap zonder één aanroeppunt aan te raken. Secrets direct met de
hoofdsleutel versleutelen zou rotatie tot een volledige herversleuteling van elke rij maken en het
vertrouwensmodel vastleggen in code.

---

## ADR-009 — De API-container voert geen outbound automation uit

**Keuze:** Proxmox-, SSH- en WinRM-adapters worden alleen in de worker-rol geladen. De API kan werk in
de wachtrij zetten; uitvoeren kan het niet.

**Waarom:** het verandert een hele klasse kwetsbaarheden (SSRF, command injection via een
requestparameter, een autorisatiefout die remote root wordt) in een ontbrekend-code-path. Het betekent
ook dat een gecompromitteerd API-proces geen credentials kan ontsleutelen voor gebruik.

**Prijs:** sommige leesoperaties die triviaal synchroon zouden zijn, worden jobs. Aanvaard; een
gecachet inventarispad bedient de UI, en een "nu vernieuwen"-actie zet een discovery-job in de wachtrij.

---

## ADR-010 — Commando's zijn registeritems, nooit teksten uit HTTP

**Keuze:** een `CommandSpec`-register definieert elk remote commando: argv-sjabloon, getypeerde
parameters, alleen-lezenvlag, timeout, uitvoerparser, vereist recht.

**Waarom:** er is geen endpoint dat een commando accepteert. Parameters zijn getypeerd en worden door de
spec geëscaped, niet aaneengeplakt. De audit toont *welke spec* met *welke getypeerde parameters* liep,
wat veel bruikbaarder is dan een shelltekst.

---

## ADR-011 — Playbooks zijn data, geen code paths

**Keuze:** upgrade-, update- en migratieworkflows zijn geversioneerde playbookdefinities, samengesteld
uit geregistreerde stappen en guards.

**Waarom:** de opdracht vereist expliciet dat de major-upgrade-engine generiek is (PVE 9 → volgende,
PBS, Ceph). Een data-gedreven engine maakt de workflow bovendien *inspecteerbaar* — de UI kan het plan
tonen vóór uitvoering, en tests kunnen op het plan controleren in plaats van op bijwerkingen.

---

## ADR-012 — Caddy als reverse proxy

**Keuze:** Caddy 2, standaard met een gegenereerd self-signed certificaat en optioneel ACME wanneer een
publieke hostnaam is ingesteld.

**Waarom:** het kleinste configuratieoppervlak, automatische HTTPS, verstandige security headers, één
binary. De dynamische discovery van Traefik levert niets op in een vaste appliance met zes services;
nginx zou ons TLS en headers met de hand laten schrijven.

---

## ADR-013 — Eén backend-image, twee rollen

**Keuze:** `velnox/backend` wordt één keer gebouwd; de services `api` en `worker` verschillen alleen in
entrypoint en in welke modules opstarten.

**Waarom:** halveert bouwtijd en imageopslag in het tar.gz-artefact, en garandeert dat api en worker
identieke domeincode draaien.

---

## ADR-014 — Debian-ISO via live-build in een container

**Keuze:** `scripts/build-iso.sh` draait Debian `live-build` binnen een Debian-container en produceert
een installer-ISO die de Velnox-bundel meelevert en bij eerste start `install.sh` uitvoert.

**Bekende beperking, gedocumenteerd in plaats van verzwegen:** live-build heeft loop devices en
verhoogde rechten nodig; de buildcontainer vereist daarom `--privileged` (of specifieke device-toegang)
op een Linux-host. ISO-bouwen wordt **niet ondersteund op Docker Desktop voor Windows/macOS**. Kan die
voorwaarde niet vervuld worden, dan faalt `build.sh --target iso` met een duidelijke melding — er wordt
nooit een niet-opstartbaar bestand geproduceerd.

**Alternatieven:** Packer met debian-installer preseed (haalbaar, voegt een tweede toolchain toe); een
cloud image bouwen in plaats van een ISO (gepland als extra doel, niet als vervanging).

---

## ADR-015 — Teststack

**Keuze:** Vitest voor unittests; geen Jest. Supertest tegen een echte NestJS-appinstantie voor
API-tests; Testcontainers (PostgreSQL + Redis) voor integratietests; Playwright voor een kleine
rooktest over installatiewizard, inloggen en één joburitvoering.

**Verplichte suites (blokkerend in CI):** tenant-isolatie (cross-tenant lezen *en* schrijven, voor elke
tenant-gebonden resource), de RBAC-rechtenmatrix, secretredactie, en de quorum-invariant van rolling
updates.

---

## ADR-016 — Ceph-upgrades zijn een apart playbook, samengesteld in het plan

**Keuze:** Ceph major upgrades vallen binnen v1-scope, geïmplementeerd als eigen playbook op de
generieke engine. Een upgradeplan voor een Ceph-cluster is een **samenstelling**: het Ceph-playbook
draait eerst volledig, daarna het PVE-major-upgrade-playbook.

**Waarom geen fase binnen de PVE-upgrade:** de twee workflows hebben verschillende werkeenheden (Ceph
herstart *daemons*, PVE upgradet *nodes*), verschillende gezondheidsmodellen (Ceph `HEALTH_OK` en
PG-status versus corosync-quorum) en verschillende faalwijzen. Ze samenvoegen levert precies de grote
monolithische functie op die de opdracht verbiedt, en maakt "alleen Ceph upgraden" — een gangbare
losstaande onderhoudstaak — onuitdrukbaar.

**Waarom Ceph eerst:** een PVE major release levert een specifieke Ceph-release en ondersteunt de vorige
niet, dus de Ceph-upgrade moet afgerond zijn terwijl het cluster nog op de huidige PVE- en
Debian-release draait.

**Versiekoppeling is data, en wordt geverifieerd:** bron → doel releaseparen staan in een
versiematrix-databestand, en de matrix wordt tijdens het opstellen van het plan tegen het live cluster
gecontroleerd. Onenigheid tussen draaiende release, doel en matrix weigert het plan in plaats van te
gokken — dezelfde veilige houding als bij de `pve8to9`-parser.

**Gevolg:** de genericiteit van de engine uit Phase 8 wordt bewezen door constructie, doordat twee zeer
verschillende workflows er ongewijzigd op draaien.

---

## ADR-017 — MFA: TOTP, optioneel maar aanbevolen; WebAuthn uitgesteld

**Keuze:** TOTP (RFC 6238) plus Argon2id-gehashte eenmalige herstelcodes. Standaardbeleid `OPTIONAL`,
met `REQUIRED_FOR_PRIVILEGED` en `REQUIRED` beschikbaar per installatie en per tenant. De UI beveelt
aanmelden aan tijdens de installatie en markeert bevoorrechte accounts zonder MFA.

**Waarom TOTP eerst:** het vereist geen hardware, werkt voor elke operator en — doorslaggevend — het
werkt voor het **noodtoegangsaccount**, dat bruikbaar moet blijven wanneer SSO en het netwerk naar de
identity provider onbereikbaar zijn. Het platform-authenticatormodel van WebAuthn past slecht bij een
account dat juist bedoeld is om vanaf een onverwachte machine tijdens een incident te werken.

**Waarom niet standaard verplicht:** de eerste beheerder wordt door de installatiewizard aangemaakt
vóórdat er een authenticator is aangemeld, en daar aanmelden afdwingen riskeert een operator buiten te
sluiten die nog geen herstelcodes heeft opgeslagen. `REQUIRED_FOR_PRIVILEGED` is één klik zodra de
installatie draait, en dat is wat de documentatie aanbeveelt.

**Opslag:** de TOTP-seed is secretmateriaal en gaat door de `SecretStore`, niet in een platte kolom.
Herstelcodes zijn gehasht, nooit opvraagbaar, en worden precies één keer getoond.

**Uitgesteld:** WebAuthn/passkeys als tweede factortype — de discriminator `user_mfa_factors.kind`
bestaat ervoor.

---

## ADR-018 — Het tar.gz-artefact bundelt images voor air-gapped installatie

**Keuze:** `build.sh --target tar` bevat standaard met `docker save` opgeslagen images; een
`--slim`-variant haalt uit een registry.

**Waarom:** Velnox wordt geïnstalleerd binnen klantnetwerken en beheer-VLAN's waar uitgaande toegang tot
een containerregistry regelmatig juist de installatie blokkeert. Circa 1 GB artefact is een lage prijs
voor "het installeert offline, in één poging".

**Eerlijke grens:** Docker zelf wordt nog steeds uit de Debian-/Docker-repositories geïnstalleerd
wanneer het ontbreekt. Een werkelijk offline host moet Docker al hebben. De installer detecteert dat
geval en zegt het vooraf, in plaats van halverwege te falen.

---

## ADR-019 — Lokalisatie: overal sleutels, ICU-catalogi, foutcodes in plaats van zinnen

**Keuze:** Engels en Nederlands in v1. Geen zichtbare tekst in applicatiecode; elke tekst is een sleutel
tegen een ICU MessageFormat-catalogus. De API geeft machineleesbare foutcodes met getypeerde parameters
terug, die de frontend rendert. Een `glossary.csv` met vaste woordenlijst is de bron van waarheid voor
zowel UI-catalogi als de Nederlandse documentatie.

**Waarom vanaf de eerste commit:** teksten achteraf uit de code halen betekent elk component en elke
exception aanraken. Het is een van de weinige keuzes die aan het begin bijna gratis is en op elk later
moment duur.

**Waarom foutcodes:** een nieuwe taal dekt API-fouten daarmee vanzelf, en de codes zijn stabiel genoeg
om op te testen, op te alarmeren en te documenteren — een bijkomend voordeel dat net zoveel waard is als
de vertaling.

**Bewust onvertaald:** auditgebeurtenissen, jobgebeurtenissen en logs. Het zijn forensische
vastleggingen, ze bevatten letterlijke Proxmox-, `apt`- en Ceph-uitvoer, en een support-engineer mag
nooit hoeven raden in welke taal het auditspoor van een klant is geschreven.

**Erkende prijs:** twee documentatiesets verdubbelen het onderhoud over vijftien fasen. Ondervangen door
in elk Nederlands bestand de bron-commit vast te leggen en een CI-controle die *waarschuwt* bij drift —
Engelse documentatie wordt nooit opgehouden door een openstaande vertaling. Zie [i18n.md](i18n.md).

---

## ADR-020 — AGPLv3

**Keuze:** GNU Affero General Public License v3.0 (canonieke tekst in `LICENSE`, letterlijk opgehaald
van gnu.org).

**Waarom AGPL boven GPL:** Velnox is netwerk-benaderde beheersoftware — precies de categorie waarin de
distributietrigger van de GPL nooit afgaat, omdat een hostende partij nooit iets "verspreidt". Artikel
13 dicht dat gat.

**Waarom überhaupt copyleft in plaats van Apache-2.0/MIT:** de waarde van dit project zit in de
opgebouwde veiligheidslogica — quorum-invarianten, preflight-parsing, herstelactiedefinities. Een
permissieve licentie nodigt uit die logica in gesloten producten op te nemen zonder dat correcties
terugvloeien, en foutieve veiligheidslogica in dit domein beschadigt productie-infrastructuur van
derden.

**Gevolgen die technisch werk zijn, geen papierwerk:**
- Naleving van artikel 13 is een productfunctie: `GET /api/v1/system/source` en een link onder
  Instellingen → Over, beide aangestuurd door een buildvariabele `VELNOX_SOURCE_URL` en de ingesloten
  git-commit.
- `THIRD-PARTY-NOTICES.md` wordt tijdens de build uit het lockfile gegenereerd en in elk artefact
  meegeleverd.
- Licenties van afhankelijkheden moeten AGPL-compatibel zijn; een CI-licentiecontrole weigert
  incompatibele toevoegingen. Dat sluit sommige commercieel gelicentieerde componentbibliotheken uit —
  een reële beperking op de frontend, en een reden waarom shadcn/ui (MIT, meegeleverde broncode) boven
  een gelicentieerde enterprise-grid is gekozen.
- Handelsmerken worden apart geregeld, omdat de AGPL er geen verleent: zie `TRADEMARK.md`.

---

## ADR-021 — zod voor requestvalidatie, niet class-validator

**Keuze:** een `ZodValidationPipe` valideert requestinvoer tegen dezelfde zod-schema's die de
API-contracten definiëren. `class-validator` en `class-transformer` worden niet gebruikt.

**Waarom:** de architectuur legt zod-contracten al in `packages/shared`. Een tweede,
decorator-gebaseerd validatiesysteem toevoegen betekent twee definities van dezelfde vorm die uit
elkaar kunnen lopen — en als ze dat doen, is degene die draait niet degene die iemand gelezen heeft.
Eén bron van waarheid is de prijs waard.

**Prijs, eerlijk gesteld:** `@nestjs/swagger` leidt schema's af uit klassedecorators, dus respons- en
bodyschema's worden expliciet in `@ApiResponse` geschreven in plaats van afgeleid. Voor fase 1 gaat dat
om een handvol endpoints. Wordt het een last, dan dicht een zod-naar-OpenAPI-generator het gat zonder
het validatieverhaal te wijzigen.

---

## ADR-022 — `consistent-type-imports` staat uit in de NestJS-apps

**Keuze:** de lintregel staat overal aan, behalve in `apps/api` en `apps/worker`.

**Waarom:** NestJS leidt constructorafhankelijkheden af uit de runtime-typemetadata die
`emitDecoratorMetadata` genereert. `import type { PrismaService }` wist de klasse, de metadata wordt
`undefined`, en injectie faalt tijdens runtime met een fout die naar de module wijst in plaats van naar
de import. De autofix van de regel introduceert precies die bug — dat gebeurde tijdens fase 1, vóór
deze uitzondering bestond. Een lintregel die stilzwijgend dependency injection kan breken hoort niet
thuis in een codebase die het gebruikt.

---

## ADR-023 — De API mag zijn eigen authenticatiemateriaal ontsleutelen, en verder niets

**Herziet ADR-009 (fase 2).**

**Besluit:** De secret store van de API weigert elk credential te ontsleutelen waarvan de soort niet
`TOTP_SEED` of `OIDC_CLIENT_SECRET` is. Die twee vormen het materiaal waarmee Velnox zijn eigen
gebruikers authenticeert. Elk credential dat bij beheerde infrastructuur hoort — Proxmox-wachtwoorden,
SSH-sleutels, WinRM-credentials — blijft alleen leesbaar voor de worker. De beperking wordt per soort
afgedwongen in `SecretStoreService`, werpt `ForbiddenCredentialKindError`, en kent geen vlag om hem
uit te zetten.

**Waarom:** ADR-009 zegt dat een gecompromitteerd API-proces geen credentials kan ontsleutelen om te
gebruiken. Het verifiëren van een TOTP-code heeft de seed nodig, in de API, op het aanmeldpad. Elke
aanmelding via de taakwachtrij leiden om de sleutel van de worker te lenen zou een wachtrij-rondgang
toevoegen aan de latency van inloggen, en zou de tweede factor achter precies het systeem plaatsen dat
een beheerder met die tweede factor wil bereiken.

Het alternatief — de API stilzwijgend alles laten lezen en ADR-009 als een streven behandelen — is hoe
een grens verandert in een opmerking. Dus is de grens verplaatst naar waar hij daadwerkelijk te houden
is, en afdwingbaar geworden in plaats van verklarend. De zin die ertoe doet is ongewijzigd: een
gecompromitteerd API-proces kan nog steeds geen enkel klantcredential ontsleutelen.

**Kosten:** De API heeft de hoofdsleutel en kan de KEK afleiden, dus de beperking is een controle in
code en niet het ontbreken van een mogelijkheid. Een fout met uitvoering van externe code in de API
zou eromheen kunnen. Wat hij wél voorkomt is het veel waarschijnlijkere geval: een autorisatiefout,
een te brede query, of een toekomstig endpoint dat meer leest dan de auteur bedoelde. De sleutels zelf
scheiden zou een tweede KEK en een sleutelbeheerverhaal vergen die fase 2 niet heeft; dat staat in
`docs/known-gaps.md` in plaats van dat het hier wordt geclaimd.

---

## ADR-024 — Eén versienummer, bij elke wijziging opgehoogd, met documentatie die meereist

**Besluit:** Het veld `version` in de root-`package.json` is de enige plek waar een versie wordt
geschreven. `scripts/version.mjs` zet hem in de negen andere manifesten, de twee compose-defaults en
`.env.example`; `pnpm run validate:version` laat de lint-taak falen zodra er iets uit de pas loopt.

**Onder 1.0.0 is het minor-nummer het fasenummer.** Elke uitgeleverde wijziging hoogt het
patch-nummer op; het afronden van een fase gebeurt met `version:phase <n>`, het enige dat het
minor-nummer verzet, en dat weigert zolang `docs/roadmap.md` die fase niet als afgerond markeert.
`validate:version` faalt wanneer de twee het oneens zijn. `bump minor` en `bump major` worden allebei
geweigerd door het script — de eerste omdat die stilletjes een fasenummer zou opmaken, de tweede
omdat 1.0.0 bereiken een besluit van de opdrachtgever is en geen rekensom.

**Gewijzigd:** de oorspronkelijke regel was `bump patch` voor een correctie en `bump minor` voor
functionaliteit. Dat is gewone semver en was verkeerd voor een product met een genummerd plan: het
kwam tijdens fase 2 al op 0.8.0 uit — het grootste deel van de nummering opgemaakt aan een vijfde van
het werk, met fase 15 op koers voorbij 0.20.0 en 1.0.0 nergens in zicht. De versie is eenmalig
achteruit hernummerd, van 0.8.0 naar 0.2.4. Dat kost echt iets, en dat is bewust betaald: een
installatie die daaroverheen wordt bijgewerkt ziet zijn versienummer dalen, wat op een downgrade
lijkt en het niet is. In fase 2 is dat zo goedkoop als het ooit wordt.

Met dit schema beantwoordt de versie de vraag "hoe ver is dit", en dat is bij een product met een
gepubliceerde roadmap de vraag die mensen daadwerkelijk stellen. Fase 9 is gesplitst in 9A en 9B;
beide zijn fase 9, dus 9B wordt uitgeleverd als patches op minor 9.

De documentatie onder `docs/` wordt tijdens de build omgezet naar HTML en meegeleverd in de
web-image, en elke pagina toont **"Deze Documentatie is toepasbaar voor versie VX.Y.Z"** (in het
Engels **"This Documentation applies to version VX.Y.Z"**). Die tekst komt uit hetzelfde
`package.json`-veld dat de draaiende software rapporteert.

**Waarom:** Documentatie op een beheerapparaat is precies nodig wanneer het netwerk er niet is, dus
zij kan niet alleen op GitHub staan. En documentatie die niet zegt welke versie zij beschrijft is
slechter dan geen: een beheerder die een upgradeprocedure uit een andere release volgt, kan echte
schade aanrichten.

Beide aan één veld koppelen is wat de zin waar maakt in plaats van decoratief. De documentatie en de
software komen uit één build en uit één versietekst, dus ze kunnen niet een release uit elkaar
liggen — en als dat toch zo is, doordat een upgrade de ene container wel en de andere niet heeft
vervangen, zegt de documentatiepagina dat, in plaats van stilletjes de verkeerde software te
beschrijven.

**Kosten:** Elke wijziging raakt nu de versie, wat in de diff van elf bestanden zichtbaar is. Dat is
juist de bedoeling: een wijziging die de versie níét ophoogt, valt als zodanig op. `install.sh`
ververst `VELNOX_VERSION` in `.env` bij elke uitvoering om dezelfde reden als de build-commit — het
is build-metadata, geen configuratie, en een vastgezette verouderde waarde zou elke
documentatiepagina een niet-bestaande mismatch laten melden. `scripts/verify-stack.sh` stelt tegen
een draaiende stack vast dat de gerapporteerde versie overeenkomt met de bron.

---

## ADR-025 — De oprichtend beheerder kan niet uit zijn eigen installatie worden gesloten

**Besluit:** Het account dat de installatiewizard aanmaakt draagt `users.is_founding_administrator`.
De roltoewijzingen ervan kunnen door niemand worden ingetrokken, ook niet door het account zelf, en
het kan niet worden uitgeschakeld zolang geen ander ingeschakeld account `roles.manage` heeft. Een
partiële unieke index staat hoogstens één zo'n account toe.

**Waarom:** Omdat het alternatief zich heeft voorgedaan. Een beheerder kon zijn eigen laatste rol
intrekken, en op een installatie met één account — wat elke installatie op haar eerste dag is — haalde
dat het laatste recht uit het systeem. Aanmelden werkte nog. Niets was toegestaan. De enige weg terug
was een `psql`-prompt, in een product waarvan het hele uitgangspunt is dat beheerders die niet nodig
zouden moeten hebben.

Uitschakelen blijft mogelijk, omdat dat omkeerbaar is voor iedereen die nog rechten heeft, en een
organisatie moet een vertrokken beheerder kunnen stoppen. De rechten afnemen is van binnenuit het
product niet omkeerbaar, en daar zit het hele verschil.

`roles.manage` en niet `system.manage` is de toets voor "is er nog een andere weg naar binnen".
Herstellen betekent een rol terugtoekennen, en een account dat rollen kan beheren maar geen
installatie-instellingen kan dat prima. Het strengere recht zou handelingen hebben geweigerd die
volkomen veilig zijn.

**Kosten:** Eén account in de installatie is permanent bevoorrecht, wat een echte concentratie van
vertrouwen is — het wachtwoord en de tweede factor ervan wegen zwaarder dan die van elk ander account.
Dat staat in de interface bij het account vermeld in plaats van dat iemand het moet ontdekken. Het
alternatief, een product dat met één klik in zijn eigen UI onbruikbaar te maken is, is erger.

Het herstel voor installaties die dit al hebben meegemaakt zit in de migratie zelf: die markeert de
oprichtend beheerder en zet de toekenning terug als die ontbreekt. Daarmee krijgt een account rechten
die het een moment eerder niet had, wat de argwaan verdient die het oproept — het dwingt de nieuwe
invariant af op bestaande gegevens, het is geen achterdeur, en het verandert niets waar de toekenning
er nog is.

---

## ADR-026 — Beheerdersgidsen staan los van de referentiedocumenten en gaan mee met de functie

**Besluit:** De meegeleverde documentatie is in tweeën gesplitst. **Gidsen** —
`getting-started.md`, `managing-access.md`, `permissions.md` en hun opvolgers — zijn taakgericht en
beantwoorden "hoe doe ik dit". **Referentiedocumenten** — architectuur, het schema, deze besluiten,
de roadmap — beantwoorden "hoe is dit gebouwd en waarom". De gidsen staan vooraan in de
leesvolgorde. Elke fase die iets toevoegt dat een beheerder doet, schrijft de bijbehorende gids in
diezelfde fase, in beide talen, en `docs/roadmap.md` legt vast welke gids elke resterende fase nog
schuldig is.

**Waarom:** De offline documentatie was de eigen technische documentatie van de repository,
weergegeven binnen het product. Dat is echt nuttig voor wie Velnox onderhoudt en vrijwel nutteloos
voor wie het bedient: iemand die een node wil toevoegen zit niet te wachten op een ADR over waarom
de worker de credentials bewaart. De twee doelgroepen willen verschillende documenten, en één
document kan ze niet allebei bedienen zonder geen van beide te bedienen.

De gids in dezelfde fase opleveren als de functie is het onderdeel dat verleidelijk is om over te
slaan. Documentatie die een fase later wordt geschreven, wordt geschreven door iemand die
reconstrueert wat hij deed, en zo komt het dat een gids een knop beschrijft die inmiddels anders
heet. Documentatie die naar fase 15 wordt geschoven, arriveert na elk besluit dat ze had kunnen
verbeteren.

**Kosten:** Elke functiefase is nu groter met een gids in twee talen, en er is één ding bij dat uit
de pas kan gaan lopen met de code. De tweede kostenpost is ondervangen waar het het meest telt: de
rolmatrix in `permissions.md` wordt in beide talen door een test met de rechtencatalogus vergeleken,
omdat het het document is waarop een beheerder toegangsbesluiten neemt en een verouderde matrix daar
een beveiligingsprobleem is en geen documentatieprobleem. De lopende tekst wordt niet machinaal
gecontroleerd en kan dat niet — `scripts/check-doc-sync.mjs` meldt vertaalachterstand, en daarbuiten
is het review.

De eerste kostenpost is de bedoeling en geen spijt. Een fase die de tijd niet kan missen om uit te
leggen wat ze heeft gebouwd, is niet klaar met bouwen.

---

## ADR-027 — Serverbeheer is een venster, geen sectie, en is afgeschermd met `system.manage`

**Besluit:** Alles over de Velnox-installatie *zelf* — de servicestatus, het auditspoor, het
certificaat dat hij serveert, de build die draait — is één venster dat vanaf de onderkant van de zijbalk opent over
waar de beheerder mee bezig was, en dat sluit met een ✕ of Escape. Het wordt alleen weergegeven bij
`system.manage`, wat in de uitgeleverde catalogus uitsluitend de MSP Super Administrator is.

**Waarom een venster en geen sectie:** dit zijn geen bestemmingen. Je komt een certificaat
controleren of een auditspoor lezen, en gaat daarna terug naar de tenant, het cluster of het account
waar je mee bezig was. Een route had daar een navigatie heen en terug van gemaakt, met verlies van
de toestand van de pagina erachter, voor iets dat twintig seconden duurt. Het is ook de eerlijke
vorm van de groepering: de server is niet nóg een ding in het landschap, het is het ding waar het
landschap *vandaan* wordt beheerd.

**Waarom die groepering:** het auditlog, het certificaat en de versie stonden tussen tenant- en
landschapsbeheer in één platte lijst, waardoor "wie heeft zich aangemeld" naast "welke build draait"
naast "geef deze persoon een rol" kwam te staan. Dat zijn verschillende taken, meestal gedaan door
verschillende mensen.

**Kosten, en wat het níét met het auditlog doet.** Het venster afschermen met `system.manage` zou
het auditlog hebben afgenomen van MSP Read Only en Tenant Administrator, die `audit.read` hebben en
geen enkel beheerrecht — en juist de alleen-lezenrol bestaat om na te gaan wat er is gebeurd. Daarom
houdt het auditlog zijn plek in de zijbalk voor wie `audit.read` heeft *zonder* `system.manage`, en
draagt het venster hetzelfde paneel voor alle anderen. Eén component, op twee plekken weergegeven;
het alternatief waren twee audittabellen die uit elkaar lopen, en die welke uit de pas gaat lopen is
juist degene waar niemand naar kijkt.

De route `/settings/certificate` is verwijderd in plaats van naast het paneel te blijven bestaan.
Iedereen die hem kon bereiken kan het venster openen, dus een tweede implementatie zou voor niemand
zijn onderhouden.

---

## ADR-028 — De interface heeft een elevatieschaal

**Besluit:** Vlakken zijn gelaagd in plaats van plat. Er is een schaduwschaal van vier stappen, een
verlichte bovenrand op alles wat verhoogd is, zachtere hoeken, en een flauwe waas op de
applicatieachtergrond. Diepte wordt in de twee thema's anders opgebouwd: op licht doet de schaduw
het werk; op donker wordt het vlak *lichter* naarmate het stijgt en draagt de highlight de rand,
waarbij schaduw alleen de scheiding verdiept.

**Waarom:** de oorspronkelijke regel was "platte vlakken, nergens gradiënten", geschreven om te
voorkomen dat dit op een marketingpagina zou lijken. Dat is gelukt, en het leverde iets op dat
overkwam als onaf — elk vlak op dezelfde diepte, dus niets zei wat waar bovenop lag, en een dialoog
zag eruit als een deel van de pagina in plaats van als iets ervoor. Prima tijdens het bouwen, fout
om uit te leveren.

De identiteit verandert niet. Nog steeds één accentkleur, nog steeds semantische kleuren alleen voor
status, nog steeds geen glassmorphism en geen decoratieve gradiënt. Wat wél verandert is dat een
kaart er nu uitziet als een object en een venster eruitziet alsof het ervoor staat.

**Kosten:** meer tokens om consistent te houden, en twee themaspecifieke elevatierecepten in plaats
van één. Een component die naar een rauwe kleur grijpt in plaats van naar de schaal ziet er in één
thema subtiel verkeerd uit en komt in het andere door de review — dat is het faalpatroon om op te
letten, en de reden dat de recepten in `globals.css` als benoemde tokens staan en niet als
utility-strings die tussen componenten worden gekopieerd.

---

## ADR-029 — pnpm 12, en de vier dingen die onderweg braken

**Besluit:** de workspace draait pnpm 12. `packageManager` in de root-`package.json` is de enige
vastlegging, gerespecteerd door CI via `pnpm/action-setup` en door beide images via corepack.

**Waarom:** er was nooit een reden voor de vorige vastlegging. `pnpm@10.33.4` is in de bootstrap-commit
van fase 1 opgeschreven en daarna nooit herzien, dus het was drift en geen besluit. pnpm heeft 11
overgeslagen; 12 is de ondersteunde lijn.

**Wat het kostte.** Vier dingen braken, en geen ervan is een versienummer:

1. **De toegestane-buildlijst is hernoemd en verhuisd.** `pnpm.onlyBuiltDependencies` in
   `package.json` — een lijst — werd `allowBuilds` in `pnpm-workspace.yaml`, een map. pnpm 12
   negeert de oude sleutel. Het laat de installatie falen in plaats van te waarschuwen wanneer een
   pakket een buildscript wil waarover niets is bepaald, dus de beheersmaatregel kon niet stilletjes
   vervallen — maar `pnpm config get onlyBuiltDependencies` echode de oude waarde nog steeds terug,
   wat er precies zo uitziet als een werkende instelling. Het leest de settings-map zonder de sleutel
   te valideren. Dat is het onthouden waard de volgende keer dat er een verhuist.

2. **Twee pakketten waren stilletjes genegeerd.** pnpm 10 waarschuwde over een geblokkeerd
   buildscript; pnpm 12 geeft een fout. `@scarf/scarf` (installatietelemetrie, via `swagger-ui-dist`)
   en `msgpackr-extract` (een optionele native versneller, via BullMQ) stonden nooit op de lijst en
   niemand had het gemerkt. Beide worden nu expliciet geweigerd, met de reden ernaast.

3. **corepack bakt pnpm niet meer in het image.** pnpm 12 wordt als native binary geleverd die zijn
   shim bij *eerste gebruik* downloadt, dus `corepack prepare --activate` laat een shim van 5 MB
   achter en geen pnpm. Het eerste dat dat zou ontdekken was de migrate-container — op het interne
   netwerk, zonder route naar buiten, tijdens een upgrade. Beide Dockerfiles roepen nu `pnpm
   --version` aan in dezelfde laag, wat de binary binnenhaalt in `COREPACK_HOME`, waar de
   runtime-stage hem erft. Geverifieerd door het image te bouwen en het migrate-commando onder
   `--network none` te draaien.

4. **Een oudere globale pnpm kan op Windows niet overdragen aan 12.** Hij downloadt het pakket zonder
   het installatiescript te draaien dat de placeholder door de native binary vervangt, en de shim
   wijst daarna naar een tekstbestand. Niet op te lossen vanuit deze repository; de README zegt
   `@pnpm/exe` op de vastgelegde versie één keer te installeren.

   Dit keert bij **elke** verhoging van de vastlegging terug, omdat de download per versie is: de
   stap naar 12.5.1 reproduceerde het precies, op een machine die al een werkende 12.3.4 had. Het
   weten waard voordat je aanneemt dat een patch-verhoging op Windows gratis is.

**Wat niet veranderde:** het verschil in het lockfile is puur aanvullend — 101 regels, geen
verwijderingen, geen enkele afhankelijkheidsversie verschoven. `lockfileVersion` is nog steeds `9.0`;
pnpm 12 zet er een tweede YAML-document voor dat de package manager zelf vastlegt.

**Herzien, 12.3.4 → 12.5.1.** Er brak niets. Lint, typecheck en de volledige testsuite slagen, beide
images bouwen en dragen de nieuwe binary, en `--network none` start pnpm nog steeds — de controle die
ertoe doet voor de migrate-container op een afgesloten netwerk. Het enige dat terugkeerde is de
Windows-overdracht hierboven, en die keert bij elke verhoging terug.

Het lockfile verschoof met 94 toegevoegde en 37 verwijderde regels, en **elk daarvan is pnpm die
zichzelf beschrijft**: de `packageManagerDependencies`-specificatie en de `@pnpm/exe.*`-regels per
platform. Geen enkel ander pakket wordt geraakt, en `lockfileVersion` is nog steeds `9.0`. Er komen
zes platforms bij die 12.3.4 niet publiceerde — android op beide architecturen, FreeBSD x64, en Linux
op ppc64, riscv64 en s390x — en daarom groeit het verschil in plaats van regel voor regel te wisselen.

Het is het vastleggen waard hoe dat bijna verkeerd ging: de eerste twee `pnpm install`-rondes lieten
het lockfile onaangeroerd, omdat de ene node_modules al kloppend aantrof en de andere
`--frozen-lockfile` was, wat per definitie niet schrijft. Het herschrijven gebeurde later, onder een
gewone pnpm-aanroep. "Ik heb gekeken en het lockfile is niet veranderd" was waar toen het gezegd werd
en onwaar tegen de tijd dat het ertoe deed — een argument om `git status` aan het eind van een
wijziging te draaien in plaats van halverwege.

**Herzien, 12.5.1 → 12.6.0.** Er brak niets. Lint, typecheck en de volledige testsuite slagen, beide
images bouwen, en `pnpm --version` antwoordt in beide 12.6.0 onder `--network none`. Het lockfile
verschoof met 62 regels in beide richtingen, en elk daarvan is weer pnpm die zichzelf beschrijft —
versienummers en integriteitshashes, dezelfde platforms als 12.5.1. De integriteit van `pnpm@12.6.0`
in het lockfile komt overeen met wat het register publiceert.

Twee dingen zijn het vastleggen waard.

De Windows-overdracht keerde hier **niet** terug — maar alleen via het pad dat getest is. 12.5.1 werd
via Node gedraaid (`node …/pnpm.mjs`), zag de nieuwe vastlegging, haalde 12.6.0 op en droeg daaraan
over, en de native `pnpm.exe` die het ophaalde is de echte binary van 51 MB, geen placeholder. Of een
globaal geïnstalleerde native `pnpm.exe` even netjes overdraagt, kon niet geprobeerd worden: op de
machine waarop dit gebeurde, blokkeert een Device Guard-beleid `pnpm.exe` volledig. De README zegt dus
nog steeds `@pnpm/exe` op de vastgelegde versie te installeren, en punt 4 hierboven blijft staan tot
iemand iets anders ziet.

En het controleren van de images vond iets dat al sinds de overstap naar pnpm 12 fout was, niet iets
dat 12.6.0 introduceerde. Het inbakken — `pnpm --version` in `/app`, als root — schrijft een
`pnpm-lock.yaml` die de package manager vastlegt, met modus 600. De build-stage van de backend kopieert
het echte lockfile eroverheen en merkte het nooit. De web-runtime doet dat niet, en droeg dus een stub
die zijn eigen `node`-gebruiker niet kan lezen; elke pnpm-aanroep in `/app` faalde met "Permission
denied". Vóór er iets veranderd werd, identiek gereproduceerd op 12.5.1 met een kaal image. Niets in de
webcontainer draait pnpm, dus geen installatie werd erdoor geraakt.

De eerste oplossing was fout, en de controle ving dat op. Het verwijderen van de stub liet pnpm in
`/app` naar het register gaan om zijn vastlegging op te lossen — offline een waarschuwing en een
terugval in plaats van een fout, maar wel een netwerkaanroep vanuit een container die er nooit een
hoort te doen. De stub is hoe pnpm zijn vastgelegde versie zonder netwerk vindt. Beide Dockerfiles
maken hem nu leesbaar in plaats daarvan, en pnpm antwoordt dan in beide images 12.6.0 onder
`--network none`, zonder waarschuwing.

De verhoging staat hier opgeschreven in plaats van impliciet te blijven, omdat de les hieronder over
vastleggingen gaat die niet meer herzien worden, en een vastlegging die al een tijd niemand verzet
heeft is precies waar die les over gaat.

**De algemene les, en de reden dat dit is opgeschreven:** een vastgelegd hulpmiddel dat al een tijd
niet is herzien is geen stabiele afhankelijkheid, het is een uitgestelde migratie. Vier gedragingen
veranderden onder een veld dat eruitziet als een versienummer, en drie ervan zouden zich als een
kapotte productie-installatie hebben gemeld in plaats van als een falende test.

---

## ADR-030 — Tenantscheiding is een filter in de datalaag dat een fout gooit als het ontbreekt

**Context.** Fase 2 handhaafde tenancy door te onthouden. `UsersController` berekende
`isMspRoot ? null : eigenTenantId` en gaf dat door; elk toekomstig lijst-endpoint had hetzelfde
moeten doen. Dat klopt precies zolang niemand het vergeet, en de faalwijze van vergeten is de rij van
een andere klant in een antwoord — de ergste fout die dit product kan hebben.

**Besluit.** Verplaats het filter naar onder de applicatie. Een Prisma client-extensie herschrijft
elke query op een tenant-gebonden model zodat die het bereik van de aanroeper meedraagt, en een query
die draait **zonder enig vastgesteld bereik gooit een fout** in plaats van alles terug te geven. Het
bereik wordt door de auth-guard ingevuld zodra de principal bekend is; tot dat moment verkeert elk
verzoek in de foutwerpende toestand.

`withSystemScope("reden")` is de enige weg eromheen. Het vereist een geschreven reden, is bewust goed
doorzoekbaar, en heeft vier aanroepers — authenticatie (een account op e-mailadres vinden is juist
wat *bepaalt* bij welke tenant een verzoek hoort), de installatiewizard (die maakt de eerste tenant
die er is), het schrijven van het auditspoor, en de guard die een principal vaststelt.

**Waarom de standaard "fout" is en niet "leeg".** Een leeg resultaat is niet te onderscheiden van een
tenant zonder rijen, dus een ontbrekend bereik zou eruitzien als een werkende functie zonder inhoud.
Een fout is een stacktrace in een test, en daar hoort hij. De prijs is dat elk nieuw codepad buiten
een verzoek luid faalt tot iemand besluit waartoe het afgebakend hoort te zijn, en dat is de bedoeling.

**Waarom een GLOBAL-recht het filter opheft en niet `isMspRoot`.** Lidmaatschap van de
MSP-organisatie is waar iemands account woont; een GLOBAL-recht is wat diegene daadwerkelijk kreeg.
Een account in de MSP-tenant dat één klant kreeg toegewezen hoort precies die klant te bereiken. Een
databasetrigger weigert een GLOBAL-recht al voor iedereen buiten de MSP-roottenant, dus de smallere
toets is ook de veilige.

**Wat het kostte.** Drie dingen die pas duidelijk werden toen ze braken:

- Het bereik moet in `where.AND`, met de eigen sleutels van de aanroeper op het *bovenste* niveau.
  Het hele filter inpakken leest prettiger en breekt `findUnique`, `update` en `delete`, omdat Prisma
  daar een uniek veld op het bovenste niveau eist en anders *"Argument where needs at least one of
  id"* antwoordt. Eerst verkeerd geschreven.
- Een `AND` die de aanroeper zelf meegaf moet aangevuld worden, niet vervangen. Vervangen laat zijn
  voorwaarde vallen en *verbreedt* de query — de enige richting waarin een beveiligingsfilter nooit
  mag bewegen.
- `role_assignments.tenant_id` is null bij een GLOBAL-recht, dus filteren op die kolom zou elk
  MSP-breed recht aan elke tenant hebben getoond. Rechten worden afgebakend via het account waar ze
  op zitten.

**Verder.** `@RequirePermission` zonder bereiksoplosser betekent stilzwijgend "een globaal recht of
niets", omdat een leeg doel alleen op GLOBAL matcht. Elk beheer-endpoint was zo geschreven, waardoor
een tenantbeheerder met `users.manage` op TENANT-bereik de accounts van zijn eigen tenant niet kon
beheren — onzichtbaar op een installatie met één tenant. `RequirePermissionSomewhere` is de oplossing
voor endpoints waarvan het bereik een eigenschap is van een rij die nog niemand gelezen heeft: de
guard weigert wie het recht nergens heeft, en de service toetst het precieze bereik zodra de rij
geladen is. Het klopt alleen als paar; de zwakkere decorator alleen zou een echte verzwakking zijn.

**Gevolgen.** Een vergeten autorisatiecontrole lekt geen gegevens meer; hij verzuimt alleen te
controleren of de aanroeper het mocht vragen. Ruwe SQL blijft door ESLint verboden met een
gedocumenteerde uitzonderingslijst, omdat die deze laag volledig omzeilt. Row-level security in
PostgreSQL blijft uitgesteld tot fase 15 als derde laag, vastgelegd in known-gaps.md in plaats van
stilzwijgend overgeslagen.

**Aangevuld in fase 5 — tabellen die hun tenant via een relatie bereiken.** De schemacontrole
hierboven keek alleen naar een kolom `tenantId`. De stappen, gebeurtenissen en logs van het
jobsysteem hebben die niet: ze bereiken hun tenant via hun job. Een ervan vergeten in
`TENANT_SCOPED` zou door die controle zijn gekomen en iedereen die een job-id raadde de jobuitvoer van
een andere klant laten lezen. De controle eist nu ook dat elk model met een relatie naar een
afgeschermd model zelf is afgeschermd, of in de test met reden staat vermeld waarom dat niet hoeft.
Zes bestaande tabellen staan vermeld — authenticatie- en geheimeninterna die via het eigen id van het
account of de credential worden gelezen — en `JobEvent` uit de afgeschermde lijst halen laat de test
falen met die naam erbij.

---

## ADR-031 — Certificaatvastlegging, en de twee manieren waarop hergebruik van verbindingen die omzeilde

**Context.** Een Proxmox-node presenteert het certificaat dat zijn eigen installer heeft gemaakt. Dat
staat in geen enkele vertrouwensopslag en kan daar ook niet in staan, dus de keuze is tussen het
vastleggen van een vingerafdruk die een beheerder buiten het kanaal om bevestigd heeft, en helemaal
geen verificatie. Vastleggen is hier strikt sterker dan verificatie via een certificaatautoriteit: het
identificeert één specifiek certificaat in plaats van alles wat een vertrouwde autoriteit toevallig
heeft ondertekend.

**Besluit.** Leg de SHA-256-vingerafdruk per cluster vast, bevestigd door de beheerder tegen
`pvenode cert info` voordat er een credential in het formulier bestaat, en controleer hem **tijdens de
handshake** — voordat de requestregel, en daarmee het API-token, naar de socket geschreven wordt. Een
afwijking sluit de verbinding terwijl de credential nog niet verzonden is, en wordt nooit opnieuw
geprobeerd: het is geen hapering, het is "deze host is niet degene die je hebt vastgelegd".

**Wat het kostte.** Twee fouten, beide gevonden door `scripts/verify-proxmox.sh` tegen een fixture, en
beide onzichtbaar voor elke unittest — omdat geen van beide een eigenschap van de vergelijking is. Het
zijn eigenschappen van een echte TLS-stack die met een echte server praat.

1. **Hergebruikte sockets vuren `secureConnect` nooit af.** De controle luisterde naar die
   gebeurtenis, die precies één keer per verbinding plaatsvindt. De globale agent van Node houdt
   verbindingen in leven, dus het tweede verzoek hergebruikte de socket en de vastlegging werd
   stilletjes overgeslagen. Een cluster dat met een bewust verkeerde vingerafdruk werd toegevoegd,
   werd geaccepteerd, verbonden en volledig uitgelezen. Een geverifieerde socket wordt nu *gemarkeerd*
   met de vingerafdruk waartegen hij gecontroleerd is, elk verzoek controleert die markering in plaats
   van uit te gaan van een handshake die het niet gezien heeft, en elke client heeft een eigen pool —
   nooit de globale agent, die met elke andere host in het proces gedeeld wordt.

2. **Hervatte sessies dragen geen certificaat.** Met de pool hersteld faalden vijf van elke zes
   aanroepen per node met "completed a TLS handshake with no certificate": een hervatte TLS-sessie
   slaat de certificaatuitwisseling over, dus er valt niets te vergelijken. De faalrichting was juist
   — het weigerde in plaats van te vertrouwen — maar het merendeel van de inventarisatie kwam leeg
   terug. Sessies worden daarom niet gecachet. Vastleggen betekent het certificaat zien, en een
   volledige handshake per nieuwe verbinding is de prijs daarvan; open verbindingen worden nog steeds
   hergebruikt, en daar zat de winst toch al.

**Gevolgen.** De ene `rejectUnauthorized: false` in het Proxmox-transport is dragend en wordt ter
plekke beargumenteerd, en de ESLint-regel die hem verbiedt vangt nu ook de niet-letterlijke vorm —
want `rejectUnauthorized: eenVariabele` is precies de vorm die hier nodig was, en een regel die een
variabele omzeilt is geen regel.

Een certificaat dat legitiem wijzigt — een vernieuwing, een opnieuw opgebouwde node — faalt gesloten
en moet opnieuw bevestigd worden. Dat is de bedoeling: een vernieuwing en een onderschepping zien er
voor software identiek uit, en alleen iemand die naar de node kijkt kan ze onderscheiden.

---

## ADR-032 — Acceptatie wordt bewezen tegen een fixture die over een echte socket antwoordt

**Context.** De acceptatiecriteria van fase 4 zeggen "een echt (of fixture-ondersteund) cluster kan
worden toegevoegd". Niemand heeft een Proxmox-cluster in CI, en het voor de hand liggende alternatief
— de client mocken — bewijst alleen dat de mock zo geschreven is dat hij het eens is met de code die
hem aanroept.

**Besluit.** Lever een fixture-Proxmox-API mee: een kleine HTTPS-server met een echt zelfondertekend
certificaat, die de endpoints beantwoordt die Velnox daadwerkelijk aanroept met de antwoordvormen die
PVE 8 teruggeeft, draaiend op het netwerk dat de worker gebruikt. `scripts/verify-proxmox.sh`
doorloopt de hele stroom via Velnox' eigen API — opzoeken, bevestigen, toevoegen, uitlezen,
teruglezen, de stekker eruit — en toetst vijftig dingen.

**Wat het de moeite waard maakt is wat het met opzet fout doet.** Eén node staat uit, één node weigert
`/apt/repositories` met een 403, Ceph heeft `noout` aan staan en één daemon loopt een release achter.
Dat zijn de paden die anders beschreven worden in plaats van doorlopen, en daar begint een
inventarisatie stilletjes te liegen.

**Het vond drie fouten in zijn eerste ronde**, alle drie in code die een review en honderd unittests
had doorstaan: beide helften van ADR-031, en een mislukte verificatie die een half toegevoegd cluster
achterliet. Het vond er ook een vierde in zichzelf — elke statuscontrole las de status van het vórige
verzoek, omdat `X="$(call …)"` in een subshell draait.

**Gevolgen.** Unittests blijven de besluiten bewijzen: wat het opnieuw proberen waard is, hoe een
byte-aantal wordt weergegeven, wat gezond heet. Alles wat een eigenschap is van een socket, een pool
of een deployment wordt hier bewezen, want dat is de enige plek waar het waar is.
`verify-tenancy.sh` bestaat om dezelfde reden en over ongeveer dezelfde grens.

---

## ADR-033 — Meldingen worden uit de inventarisatie afgeleid, niet opgeslagen

**Context.** Fase 4 moet een cluster tonen waar `noout` is blijven staan, een node die offline is, een
cluster dat zijn quorum kwijt is. De voor de hand liggende vorm is een `alerts`-tabel.

**Besluit.** Bereken ze in plaats daarvan bij elk verzoek uit de inventarisatie. Geen tabel, geen
bevestigen, geen onderdrukken, geen notificatie.

**Waarom.** Een opgeslagen melding heeft een levenscyclus nodig — gemeld, bevestigd, opgelost, opnieuw
gemeld — en elk onderdeel daarvan kan zo fout gaan dat het erger is dan het niet te hebben. Een
melding die blijft staan nadat de oorzaak weg is leert mensen het scherm te negeren; een die bij elke
uitleesronde opnieuw meldt leert ze dat sneller. Afgeleide meldingen kunnen niet verouderd zijn: de
conditie wordt gelezen op het moment dat de vraag gesteld wordt, en een melding verdwijnt op het
moment dat de oorzaak dat doet.

**Wat het kost, en waar dat staat.** Niets bereikt iemand die niet naar het scherm kijkt, en er is
geen historie van wat er vorige dinsdag meldde. Beide staan in known-gaps.md en beide willen het
jobsysteem eronder, en dat is fase 5. Nu de helft bouwen zou betekenen dat er later een half gebouwde
levenscyclus gemigreerd moet worden, uit gegevens waar beheerders al op waren gaan vertrouwen.

---

## ADR-034 — De inventarisatieschermen verversen zichzelf, en er is geen "nu uitlezen"

**Besluit:** De clusterlijst en de clusterpagina lezen zichzelf elke twee seconden opnieuw. Een
**Refresh**-knop doet diezelfde leesactie op verzoek. De knop **Nu uitlezen**, die een uitleesronde
tegen Proxmox in de wachtrij zette, is weg.

**Waarom die knop weg is.** Hij zag eruit als verversen en was dat niet. Hij zette een taak in de
wachtrij, kwam meteen terug, en liet een scherm achter dat er precies zo uitzag als een moment
eerder — dus de voor de hand liggende lezing was dat er niets gebeurde, en de voor de hand liggende
reactie was nog een keer drukken. Wat een beheerder van een knop op die plek meestal wil is het
scherm met actuele gegevens, en dat is een herlezing van de pagina: lokaal, goedkoop en direct.

**Wat verversen niet doet.** Het benadert Proxmox niet. Zowel het interval als de knop lezen wat
Velnox al heeft; het uitlezen van de hypervisor gebeurt volgens het schema van elk cluster. Dat in
de documentatie zeggen doet er meer toe dan het klinkt, want het woord nodigt uit tot de
tegenovergestelde aanname.

**De prijs, ronduit gezegd.** Er is nu geen manier meer om een uitleesronde buiten het schema af te
dwingen. Wat rest is het interval per cluster, dat verkort en weer teruggezet kan worden. Dat is een
echt verlies voor het geval "ik heb net de firewall gerepareerd en wil zien dat het werkt", en het
is het terugdraaien waard als dat geval vaak blijkt voor te komen — als een duidelijk aparte actie,
niet als een knop met het etiket van een verversing.

**Waarom pollen, en waarom twee seconden.** Er is nog geen stream; het taaksysteem en zijn
voortgangskanaal komen in fase 5, en dit is wat het tot die tijd vervangt. Twee seconden is het
tempo waar de eigenaar om vroeg. Elke tik is één herlezing van de pagina — voor de lijst één
clusterquery per geopend tabblad — dus gratis is het niet, en in een verborgen tabblad loopt het
niet: het interval stopt bij `visibilitychange` en ververst één keer bij terugkomst, want zes
vergeten tabbladen die een week lang pollen is een prijs die niemand gekozen heeft. Wanneer de
stream landt, is dit wat hij vervangt.

**Het pauzeert wanneer iemand ergens middenin zit.** Een cluster toevoegen is drie stappen met een
vingerafdruk die je met een ander scherm vergelijkt, dus het is precies het scherm dat een beheerder
verlaat en weer opzoekt — en de verversing die bij terugkomst afging, nam het halfingevulde
formulier mee. Het interval staat uit zolang dat formulier open staat, en zolang een verwijdering
bevestigd moet worden.

Dat is evenzeer een omweg als een voorkeur, en het onderliggende probleem verdient het om opgeschreven
te worden: `router.refresh()` rendert ook de **layout** opnieuw, en de shell-layout geeft
`<SessionRecovery />` terug in plaats van de hele applicatie zodra `getSession()` leeg terugkomt — een
verlopen access token, of een API-aanroep die langer dan vijf seconden duurde. De boom vervangen
ontkoppelt alles eronder. Bij navigatie is dat zeldzaam genoeg om onzichtbaar te blijven; bij één
verversing per twee seconden houdt het op zeldzaam te zijn. Pauzeren waar het het meest pijn doet is
niet hetzelfde als het oplossen.

---

## ADR-035 — Een job is eerst een rij, en een worker houdt hem vast met een lease

**Besluit:** Een job bestaat in de database voordat hij ergens anders bestaat. De wachtrij draagt een
job-id en verder niets; alles over de job — status, stappen, gebeurtenissen, uitvoer — staat in
PostgreSQL. Een worker die een job oppakt, houdt hem vast met een **lease** die hij elke tien seconden
vernieuwt, en elke status die de worker schrijft is afhankelijk van het nog vasthouden daarvan. Een
job waarvan de lease verloopt, wordt op mislukt gezet met `job.worker_lost` en **nooit automatisch
opnieuw gestart**.

**Waarom eerst de rij.** Redis is de wachtrij, en een wachtrij mag op een manier verliesgevoelig zijn
waarop een registratie dat niet mag. Een geleegde of opnieuw opgebouwde Redis verliest plaatsen in de
wachtrij; hij mag niet de geschiedenis verliezen van wat er met het cluster van een klant is gedaan.
Met de rij als registratie is het ergste geval van een verloren wachtrijregel een job die zichtbaar
op *In wachtrij* blijft staan, en dat ziet een mens en kan hij oplossen.

**Wie een job waarheen mag verplaatsen.** Eigenaarschap is per status verdeeld, en dat is wat
eenvoudige voorwaardelijke schrijfacties voldoende maakt:

- **In wachtrij** en **Wacht op goedkeuring** zijn van niemand. De API verplaatst ze: geannuleerd
  voordat ze starten, goedgekeurd terug de wachtrij in, afgewezen.
- **Preflight**, **Actief** en **Valideren** zijn van één worker. De API schrijft hun status nooit;
  een annulering zet een vlag die de worker op het eerstvolgende veilige punt respecteert.

Elke schrijfactie noemt de status die hij verwacht. Leest de API *In wachtrij*, claimt een worker de
job, en probeert de API hem daarna te annuleren, dan mist de schrijfactie van de API en valt hij
terug op de weg voor een actieve job. Geen vergrendelingen over verzoeken heen, geen gedistribueerde
coördinatie.

**Waarom een lease, en waarom afhankelijk daarvan.** Een worker die crasht, zegt dat nooit. De lease
is hoe de anderen erachter komen: verlopen, en de job wordt als verloren gemarkeerd door de
verzoening van welke worker het eerst merkt, bij het opstarten of op zijn tik van vijftien seconden.
De voorwaardelijke schrijfactie dekt de andere helft: een worker die alleen *traag* was — een lange
pauze voor geheugenbeheer, een haperende database — en wakker wordt nadat zijn job is verzoend, kan
daarna niet *Geslaagd* over *Mislukt* heen schrijven. Zijn schrijfactie mist, en hij stopt.

**Waarom niet automatisch opnieuw.** De standaard van BullMQ is een vastgelopen job aan een andere
worker te geven. Voor een job die halverwege een cluster wijzigt, betekent dat de eerste helft twee
keer doen, en niets in Proxmox of apt belooft dat die eerste helft idempotent is. De jobwachtrij
draait met `maxStalledCount: 0`, en een verloren job wordt als verloren gemeld, met de stap waar hij
was. Een mens beslist of hij opnieuw wordt geprobeerd, en een nieuwe poging is een **nieuwe** job die
naar zijn voorganger verwijst, zodat de geschiedenis van de mislukte poging nooit wordt herschreven.

**De toestandsmachine is gedeeld.** `packages/shared/src/jobs.ts` bevat de overgangstabel die zowel
de worker als de API gebruikt. Een test loopt alle honderd geordende paren van statussen af, en een
andere leest de migratie om te controleren dat de lijst actieve statussen van de database — die
bepaalt welke jobs een gelijktijdigheidssleutel vasthouden — dezelfde lijst is.

**Het vierogenprincipe gaat over goedkeuren, niet over afwijzen.** Een goedkeuringspunt dat een
tweede persoon vereist, voorkomt dat de aanvrager zijn eigen wijziging goedkeurt. Het voorkomt niet
dat hij hem afwijst: je eigen verzoek afwijzen is het intrekken, en dat kon hij toch al door te
annuleren. De eerste versie blokkeerde beide; `verify-jobs.sh` ving het.

**De prijs.** Het duurt ongeveer een halve minuut voordat een verloren job wordt opgemerkt: de lease
van dertig seconden, plus hooguit één tik van de verzoening. Gemeten: 33–34 seconden van `SIGKILL`
tot *Mislukt*. Een kortere lease zou het eerder opmerken en een gewone pauze ook vaker voor een
dood aanzien; dertig seconden is de afweging.

---

## ADR-036 — Live jobgebeurtenissen: eerst luisteren, dan terugspelen, alles nummeren

**Besluit:** De gebeurtenissen van een job worden naar de browser gestreamd via **server-sent
events**, verdeeld vanuit Redis pub/sub. Elke gebeurtenis heeft een volgnummer per job zonder gaten;
de stroom koppelt zijn luisteraar **voordat** hij de geschiedenis leest; elk bericht op de lijn dat
geen commentaar is, draagt een echt volgnummer als id; en de stroom eindigt met een `done`-gebeurtenis
waarop de browser sluit.

**Waarom SSE en geen WebSockets.** Het verkeer gaat één kant op, de `EventSource` van de browser
verbindt uit zichzelf opnieuw en stuurt daarbij `Last-Event-ID` mee, en het gaat over dezelfde
origin, cookie en proxy als elk ander verzoek. Een WebSocket zou een tweede protocol door Caddy
toevoegen om een richting te winnen die niets gebruikt.

**Volgnummers zonder gaten.** Het nummer komt uit het ophogen van `jobs.event_seq` binnen de
transactie die de gebeurtenis invoegt, en die vergrendelt de rij van de job. Twee schrijvers — een
worker en een API die annuleert — komen na elkaar, en een rollback neemt de ophoging mee. Daardoor kan
een browser die opnieuw verbindt zeggen "alles na 41" en precies dat krijgen.

**Eerst luisteren, dan terugspelen.** Een gebeurtenis die gepubliceerd wordt tussen "geschiedenis
lezen" en "beginnen met luisteren" zou in dat gat vallen en nooit aankomen. Dus de luisteraar wordt
eerst gekoppeld en buffert, de geschiedenis wordt gelezen en verstuurd, daarna de buffer, en de
volgnummers maken elke overlap onschadelijk.

**Elk id is een echt id.** NestJS voorziet elk SSE-bericht *zonder* id van een eigen teller per
verbinding — 1, 2, 3 — en een browser onthoudt welk id hij het laatst zag. De eerste versie stuurde
zijn hartslag en zijn afsluitende `done` zonder id, waardoor de plek van een browser in de stroom
het nummer van Nest kon worden in plaats van dat van de job, en een herverbinding vanaf het verkeerde
punt zou terugspelen. Gevonden door `verify-jobs.sh`, waarvan de volgnummercontrole ids zag die niet
van de job waren. De hartslag is nu een SSE-commentaar, dat browsers negeren en dat Nest niet
nummert; `done` herhaalt het laatste echte id.

**Waarom `done`.** `EventSource` verbindt opnieuw zodra een verbinding sluit, ook als de server dat
bewust doet. Zonder een signaal om te stoppen zou de pagina van een afgeronde job eeuwig om de paar
seconden opnieuw verbinden. Bij `done` sluit de pagina de stroom; en wie opnieuw verbindt met een al
afgeronde job, krijgt direct `done` in plaats van een open verbinding die nooit meer iets zegt.

**Eén abonnee per API-proces.** Een Redis-verbinding in abonneemodus kan niets anders, dus één
patroonabonnement per proces verdeelt naar elke open stroom, in plaats van één verbinding per
browsertabblad.

**De prijs.** Elke gebeurtenis is een schrijfactie in de database en een publicatie. De tien
voortgangsmeldingen per stap van de zelftest zijn tot nu toe het drukste geval; een playbook dat
vaker voortgang meldt dan een mens kan lezen, hoort minder vaak te melden.

---

## ADR-037 — De ISO-bibliotheek, en de eerste keer dat Velnox naar Proxmox schrijft

**Besluit:** De bibliotheek is **één opslag voor de hele installatie**, in een eigen Docker-volume,
met twee grenzen die worden gecontroleerd voordat er iets wordt geschreven. Elke verplaatsing van een
bestand — ophalen van een URL, een upload controleren, naar een cluster pushen, terughalen, van een
cluster verwijderen — is een **job**, en elke job die niet afmaakt laat aan geen van beide kanten iets
achter. Pushen naar een cluster gaat via Proxmox' eigen upload-aanroep, en dat maakt dit de eerste
keer dat Velnox iets verandert aan de infrastructuur van een klant.

**Eén opslag, geen tenant.** `library_items` heeft geen tenantkolom en geen relatie met iets dat er
een heeft. Een ISO van Windows Server is voor elke klant hetzelfde bestand, en een opslag per tenant
zou het één keer per klant op dezelfde schijf bewaren. De bibliotheek lezen is `library.read`, dat
elke rol heeft, omdat een tenant er vanaf Fase 5B uit kiest. Toevoegen en verwijderen is
`library.manage`, alleen voor MSP-rollen: een klant die de bibliotheek vult, vult hem voor iedereen.
Een bestand *op een cluster* zetten is helemaal geen bibliotheekrecht — het schrijft naar iemands
infrastructuur, dus het is `clusters.manage` op dat cluster, gecontroleerd zodra het cluster bekend is.

**Twee grenzen, allebei bij naam genoemd als ze weigeren.** `VELNOX_LIBRARY_MAX_GB` is het eigen
budget van de bibliotheek, inclusief overdrachten die nog lopen. `VELNOX_LIBRARY_MIN_FREE_GB` is dat
van de schijf: standaard deelt het volume een schijf met PostgreSQL en Redis, en een volle schijf is
daar geen mislukte upload maar een installatie die stilstaat. Beide worden getoetst aan wat nog
geschreven moet worden — een hervatte upload heeft al een deel geschreven — waarbij ruimte die aan
lopende overdrachten is toegezegd eerst wordt afgetrokken, zodat twee uploads die elk passen hem
samen niet kunnen overvullen. Een weigering zegt welke grens en welke getallen ("de bibliotheek
bevat 95 van 100 GB"), want *schijf vol* vertelt een beheerder niets over wat hij moet veranderen.

**Twee manieren erin.** Een URL, die de worker ophaalt, en een browserupload, die de API in stukken
van 32 MiB ontvangt. Stukken zijn de prijs van een upload die een verbroken verbinding overleeft: elk
stuk zegt waar het begint, een stuk op een andere positie wordt geweigerd met de positie die de
server heeft, en de browser hervat vanaf daar. De body van een geweigerd stuk wordt toch gelezen
voordat de weigering wordt verstuurd; vroeg antwoorden en sluiten liet de TCP-stack van de client de
verbinding resetten en precies het antwoord weggooien dat zei waar verder te gaan.
`verify-library.sh` ving het, af en toe, wat de slechtste manier is.

**Een URL ophalen is server-side request forgery tot het tegendeel bewezen is.** De worker is het
proces met een route naar de beheernetwerken van klanten, en het adres wordt gekozen door wie de URL
toevoegt. Geweigerd: loopback, link-local (cloud-metadata), multicast, carrier-grade NAT, en **elk
netwerk waar de worker zelf aan hangt**, want zo worden Velnox' eigen database en Redis bereikt.
Toegestaan: al het andere, privébereiken inbegrepen — de ISO's van een MSP staan heel vaak op een
interne bestandsserver, en RFC 1918 weigeren zou de functie nutteloos maken op precies de netwerken
waarvoor hij bedoeld is. De controle gebeurt op het adres dat de verbinding gebruikt: het antwoord
van de resolver wordt gecontroleerd en dat adres wordt gebeld, dus een naam die de tweede keer iets
anders antwoordt, wint daar niets mee. Geen redirect van https naar http, hoogstens vijf redirects die
elk opnieuw worden beoordeeld, geen inloggegevens in de URL, certificaten gecontroleerd zonder
schakelaar om dat uit te zetten, en de bytegrens gehandhaafd terwijl de bytes binnenkomen. Het adres
dat wordt getoond en gelogd heeft zijn querystring niet, omdat ondertekende downloadlinks daar hun
handtekening dragen — en zodra de download voorbij is, geslaagd of niet, geldt dat ook voor het
opgeslagen adres. Het volledige adres bestaat alleen zolang iets ervan moet ophalen.

**De naam zegt wat het is; de bytes moeten het ermee eens zijn.** Een bestand dat `.iso` heet moet
een ISO 9660- of UDF-descriptor hebben, een schijfimage met `.qcow2` of `.img` moet beginnen met de
qcow2-magic, en een verschil laat de controle mislukken met de reden op het item. De SHA-256 wordt
onderweg naar binnen berekend en is de waarde waartegen elke latere push wordt gecontroleerd.

**Leesbare namen worden afgeleid, en zijn te corrigeren.** `Windows11_25H2_Dutch.iso` leest als
*Windows 11 Version 25H2 Dutch*, of *… Nederlands* voor wie Velnox in het Nederlands leest, omdat de
taal als code wordt opgeslagen en in de taal van de lezer wordt genoemd. Een bestandsnaamparser is
een heuristiek en een verkeerd zelfverzekerd label is erger dan een eerlijk ruw label, dus titel en
taal kunnen allebei worden overschreven, en elke logregel noemt de echte bestandsnaam.

**De push.** Proxmox' `upload`-aanroep neemt het bestand als multipart-body met een checksum. Velnox
streamt het vanaf het volume, en begint pas met de body als de TLS-pin is geslaagd — het certificaat
wordt gecontroleerd voordat er één byte van het bestand vertrekt — en stuurt de SHA-256 mee, zodat
Proxmox het bestand bij aankomst zelf controleert en een verschil weigert. Vóór het versturen
bevestigt een **controlestap** dat de opslag aan staat, dat contenttype accepteert, ruimte heeft, en
nog geen bestand met die naam bevat. Dat laatste maakt het opruimen veilig: nadat bewezen is dat de
naam vrij was, is alles wat er na een geannuleerde of mislukte push staat het halfafgemaakte werk van
deze job zelf, en wordt het verwijderd. Een bestand dat er al stond wordt geweigerd, nooit
overschreven. Na de upload leest een **bevestigingsstap** Proxmox' eigen inhoudslijst en controleert
de grootte — een upload-aanroep die succes meldt is niet hetzelfde als een bestand dat er staat.

Schijfimages gaan als `import`-content omhoog, het type waaruit Proxmox een schijf leest als er een VM
van wordt gemaakt, onder een `.qcow2`- of `.raw`-naam, omdat Proxmox aan de extensie bepaalt hoe het
een import leest.

**Opruimen vóór de eindstatus.** Het opruimen van een job draait voordat de job als afgerond wordt
vastgelegd, en een opruiming die mislukt is een eigen vastgelegde uitkomst (`job.cleanup_failed`),
geen succes met een voetnoot. Een worker die sterft kan niet achter zichzelf opruimen, dus draait er
een **veger** bij het starten van de worker en elk kwartier: items waar een dode job aan schreef
worden als `job.worker_lost` mislukt, uploads die een dag stil zijn worden verwijderd, bestanden
zonder rij worden verwijderd, en rijen waarvan het bestand weg is worden als `library.file_missing`
mislukt, zodat het scherm ze niet meer aanbiedt.

**Overwogen alternatieven.** Een bibliotheek per tenant (afgewezen: hetzelfde bestand één keer per
klant opgeslagen, en niets wat een tenant nodig heeft dat `library.read` niet geeft). Een URL direct
naar het cluster streamen zonder kopie te bewaren (afgewezen: elke push zou opnieuw downloaden, en er
zou niets gecontroleerd zijn voordat het bij een klant aankwam). Pushen via SSH (afgewezen: de
upload-aanroep van de API bestaat, controleert de checksum zelf, en heeft niets op de node nodig wat
Velnox nog niet heeft).

**Kosten.** De bibliotheek is een tweede groot ding op de Velnox-host om te back-uppen, of bewust
niet. De bestanden zijn vervangbaar — ze kwamen ergens vandaan — dus de back-uprichtlijn behandelt
het volume als optioneel, en de rijen als deel van de database.

---

## ADR-038 — SSH op een cluster: optioneel, alleen SFTP, hostsleutels vastgepind

**Besluit:** Een bestand *van* een cluster kopiëren gebruikt SSH, per cluster ingesteld en uit tot
iemand het instelt. De worker opent **SFTP en verder niets** — er is geen codepad dat een commando
uitvoert. De hostsleutel van elke node wordt gelezen, getoond en bevestigd voordat er inloggegevens
worden aangeboden, precies zoals een TLS-vingerafdruk bij het toevoegen van een cluster (ADR-031).

**Waarom überhaupt SSH.** De API van Proxmox kan een bestand op een opslag zetten en er een
verwijderen, en heeft geen aanroep om er een terug te lezen; de enige download die hij aanbiedt is
file-restore uit Proxmox Backup Server. Een ISO van een cluster naar de bibliotheek halen heeft dus
een andere weg naar binnen nodig. De eigenaar koos SSH, per cluster en optioneel, boven de
alternatieven hieronder.

**Ingesteld zoals een cluster wordt toegevoegd.** Een **probe** maakt verbinding met elke online
node, legt de hostsleutel vast die hij toont, en beëindigt de handshake vóór de gebruikersauthenticatie
— er gaat nooit een gebruikersnaam of sleutel naar een host die niemand heeft bevestigd. De beheerder
vergelijkt de vingerafdrukken met de nodes (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`) en
bevestigt. **Configureren** slaat daarna de privésleutel versleuteld op in de secret store, pint de
sleutel van elke node vast, en bewijst dat de sleutel SFTP opent op elke vastgepinde node. Weigert
een node, dan wordt alles wat deze aanroep opsloeg er weer uitgehaald en blijft de vorige instelling,
als die er was, zoals hij was. De privésleutel wordt door geen enkel endpoint teruggegeven.

**Een andere sleutel weigert de verbinding voordat de inloggegevens worden aangeboden**, dezelfde
regel als bij de TLS-pin. Een node die opnieuw is geïnstalleerd moet opnieuw worden bevestigd, bewust.

**Waar het bestand staat.** Velnox raadt geen paden op een node. Het vraagt de API van Proxmox naar
het pad van het volume en gebruikt het alleen als het absoluut is, geen `..` bevat en eindigt op de
verwachte bestandsnaam — het pad komt van de node, en wordt voor precies één leesactie gebruikt.

**Wat het account nodig heeft.** Leestoegang tot de opslagmappen, en verder niets. Een beheerder kan
het een login geven die alleen SFTP mag (`ForceCommand internal-sftp`) zonder iets te verliezen wat
Velnox gebruikt; de handleiding raadt dat aan.

**Overwogen alternatieven.** Proxmox' `download-url` omgekeerd gebruiken (bestaat niet). Een omweg
via back-up en restore in PBS (zwaar, en niet elk cluster heeft PBS). Exec over SSH met `cat` of
`rsync` (afgewezen: dat vraagt een shell, en een shell is iets veel groters om een dienst te geven dan
een leesactie op een bestand). Een agent per node (afgewezen: iets om te installeren en bij te houden
op elke node van elke klant, voor één functie).

**Kosten.** Nog een set inloggegevens per cluster, en nog een set vingerafdrukken om te bevestigen en
na een herinstallatie opnieuw te bevestigen. SSH is ook de eerste verbinding met een node die niet de
Proxmox-API is, waar de rotatie van inloggegevens in Fase 10 op zal voortbouwen — de reden dat
`nodes` sinds Fase 4 een kolom voor de hostsleutel had gereserveerd.

---

## ADR-039 — Uitrol: antwoorden op een cd, één credential per geheim, een audited onthulling

**Besluit:** Een VM wordt vanuit een Autoconfig-template gebouwd door één job, `vm.provision`. De
gast krijgt zijn configuratie op een kleine ISO die de job schrijft — `Autounattend.xml` voor Windows,
een cloud-init-NoCloud-seed voor Linux — en die van de opslag wordt verwijderd als de job eindigt, hoe
die ook eindigt. Elk geheim is een eigen credential. De wachtwoorden van een VM worden één keer
bepaald, opgeslagen als credential van die VM, en alleen via een vastgelegde onthulling aan een mens
getoond.

**Waarom een cd.** Windows Setup leest `Autounattend.xml` uit de root van elk verwisselbaar station,
en de NoCloud-bron van cloud-init leest een volume met het label `cidata`. Proxmox kan een ISO koppelen
vanaf elke opslag die `iso`-inhoud accepteert, en de upload-aanroep die de bibliotheek al gebruikt
(ADR-037) zet er een neer met gecontroleerde checksum. Proxmox' eigen cloud-init-drive was het voor
de hand liggende alternatief en viel af: alles voorbij de paar ingebouwde velden vraagt een
`snippets`-opslag en een bestand daarop, wat de API niet kan — daar zou SSH voor nodig zijn, en dat is
optioneel (ADR-038). De ISO wordt geschreven door een kleine ISO 9660-schrijver met Joliet-namen;
`blkid`, `isoinfo` en de Linux-kernel lezen wat hij schrijft zoals bedoeld.

**Linux vanuit cloud images, niet vanuit installers** — afgesproken met de eigenaar: in seconden
bruikbaar, elke keer gelijk. Wachtwoorden gaan naar cloud-init als SHA-512-crypt-hashes, nooit leesbaar;
`user-data` wordt geschreven als JSON onder `#cloud-config`, wat YAML leest, zodat niets afhangt van
zelfgemaakte quoting. `cloud-init schema` accepteert de uitvoer op de oudste en de nieuwste cloud-init
die de images meeleveren.

**Windows: wat het onbeheerd maakt.** De editie wordt gekozen via `/IMAGE/NAME`, uit een lijst die uit
de eigen `install.wim` van de ISO wordt gelezen (UDF en WIM net ver genoeg gelezen) — een naam die niet
in de ISO staat installeert stilzwijgend de eerste editie, dus het formulier biedt alleen namen die de
ISO heeft. VirtIO-opslagdrivers laden tijdens Setup vanaf de driver-ISO. Eén automatische aanmelding
draait de commando's die de drivers en de guest agent installeren, de automatische aanmelding en het
leesbare `DefaultPassword` verwijderen dat Windows anders in het register laat staan, en als laatste
een markeerbestand schrijven. UEFI-installatiemedia van Windows vragen om een toets voordat ze
opstarten; de job drukt de eerste twintig seconden na het starten op Enter, en latere herstarts
lopen af naar de schijf.

**Klaar is als de gast het zegt.** De installatie is klaar als de guest agent het markeerbestand kan
lezen dat als laatste wordt geschreven. Niet "de VM herstartte" of "hij heeft een adres": beide
gebeuren halverwege.

**Een mislukte installatie laat niets achter.** Het opruimen — vóór de job zijn einde vastlegt
(ADR-037) — stopt de VM en vernietigt hem met zijn schijven, verwijdert de antwoord-ISO en een half
verstuurde upload, en laat de wachtwoorden vallen. Lukt het vernietigen niet, dan mislukt de job als
`provisioning.cleanup_failed` met het VMID, omdat een VM die Velnox maakte en niet kon verwijderen iets
is voor een mens. Verzoeken die een VM wijzigen worden één keer verstuurd en nooit herhaald: een
aanmaak waarvan het antwoord verloren ging mag niet opnieuw.

**Geheimen.** De vaste wachtwoorden, productcode en PDF-wachtwoord van een template zijn elk één
`TEMPLATE_SECRETS`-credential. De API schrijft ze en kan ze niet lezen (ADR-009), dus één wijzigen mag
nooit vragen dat een ander wordt ontsleuteld; één blob had dat gevraagd. Een kloon kopieert daarom de
instellingen en niet de geheimen — wat ook het goede antwoord is, want de vaste wachtwoorden van een
MSP horen niet via een gekopieerd template bij een klant terecht te komen. De wachtwoorden van een VM
worden bepaald door de worker (die kan de vaste van een template lezen), opgeslagen als
`GUEST_CREDENTIALS`-credential voordat iets ze gebruikt, en dertig dagen na oplevering verwijderd.

**De onthulling, en de aanvulling op ADR-009.** `GUEST_CREDENTIALS` is het enige soort naast de
infrastructuur dat de API mag lezen, en alleen in `ProvisioningService.reveal`: `clusters.manage` op
het cluster, vastgelegd in het auditlog voordat het antwoord vertrekt — weigeringen ook — en een
antwoord met een vervaltijd waar de pagina zich aan houdt. Dat is de expliciete break-glass die de
regels van het project toestaan voor een wachtwoord dat de frontend bereikt. Het punt van ADR-009
blijft staan: de API ontsleutelt nog steeds niets wat hij tegen infrastructuur zou gebruiken.

**Het installatieverslag.** Eén keer gemaild — de rij wordt geclaimd voordat de mail vertrekt — zonder
wachtwoord in de tekst. Zonder wachtwoorden bij `VELNOX_ONLY`; met wachtwoorden bij `ENCRYPTED_PDF`,
versleuteld met AES-256 **revisie 6**. pdfkit schrijft revisie 5, waarvan de wachtwoordcontrole één
SHA-256 is en die ISO 32000-2 afkeurde omdat raden er goedkoop tegen is; de bestandssleutel is in
beide gelijk, dus die wordt met Algoritme 2.B opnieuw ingepakt voordat pdfkit het woordenboek
schrijft. Dat grijpt in pdfkit in, dat daarom is vastgezet. Het wachtwoord van de PDF reist nooit in de
mail: het wordt één keer getoond aan wie het vroeg, of op het template ingesteld.

**Uitgaande mail: aan betekent bewezen.** De worker verstuurt, omdat die het wachtwoord van de server
mag lezen. De verbinding wijzigen zet mail uit tot er met de nieuwe instellingen een test is verstuurd.

**Overwogen alternatieven.** Proxmox' cloud-init-drive (vraagt snippets, en dus SSH). Een
antwoordbestand dat Velnox via HTTP serveert (de gast zou een route naar Velnox nodig hebben, die
klantnetwerken vaak niet geven). Windows installeren vanuit een gesyspreppte template-VM (snel, en een
ander product: het vraagt een golden image per klant en per editie, bijgehouden met updates). De
`exec` van de guest agent om de installatie te volgen (dat gaf de job een shell in elke klant-VM; een
bestand lezen is genoeg).

**Kosten.** De antwoord-ISO bevat de omkeerbare wachtwoorden van unattend op de opslag van de node
zolang de installatie loopt. De fixture bewijst de hele stroom maar installeert niets; of een echte
Setup en een echte cloud-init accepteren wat ze krijgen, is bewezen door de tests van de generatoren en
de eigen validators van de formaten, en staat bij de bekende hiaten tot het op een echt cluster is
gezien.

---

## Versiedoelen

| Component | Versie |
|---|---|
| Node.js | 22 LTS |
| pnpm | 12.x (fase 0 noemde 9.x; zie ADR-029 voor de stap 10 → 12) |
| NestJS | 11.x |
| Next.js | 15.x |
| React | 19.x |
| Tailwind CSS | 4.x |
| PostgreSQL | 16 |
| Redis | 7.x |
| Prisma | 6.x |
| Caddy | 2.x |
| Debian base image | bookworm-slim |
| Proxmox VE-ondersteuning | 8.x en 9.x (upgradepad 8 → 9) |
| Ceph-ondersteuning | releases zoals vastgelegd in de versiematrix, geverifieerd tegen het live cluster bij het opstellen van het plan |
| Lokalisatie | `en` (bron), `nl`; ICU MessageFormat via next-intl |
| Licentie | AGPL-3.0-or-later |

---

*De naam en het logo van Velnox worden gebruikt door The Velnox Foundation. Er is geen merk geregistreerd of geclaimd; de AGPLv3 verleent daar geen rechten op. Velnox is vrije software onder de AGPLv3.*

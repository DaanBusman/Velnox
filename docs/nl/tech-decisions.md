# Velnox — Technologiekeuzes (ADR-log)

> **Vertaling.** Bron: [docs/tech-decisions.md](../tech-decisions.md) @ `562b881`.
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

**Keuze:** Next.js 15, App Router, TypeScript, Tailwind, shadcn/ui.

**Waarom BFF:** de browser houdt geen token vast. Sessiecookies blijven `HttpOnly` en same-origin, en
pagina's lezen de API vanuit Server Components over het interne Docker-netwerk.

**Gewijzigd in fase 1 — geen proxyroute.** Het oorspronkelijke plan voegde Next route handlers toe die
`/api/v1/*` proxyden. Caddy serveert de API al op dezelfde origin, en dát is wat CORS wegneemt en de
`HttpOnly`-cookie laat werken; bovendien was de API van de publieke origin houden nooit haalbaar,
omdat machineclients API-tokens tegen een bereikbare API nodig hebben. De proxy zou een extra hop en
een tweede code path zijn geweest zonder winst in veiligheid, dus is hij geschrapt. `lib/api.ts` is
gemarkeerd als `server-only`, wat een onbedoelde import vanuit een Client Component tot een buildfout
maakt.

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
Elke wijziging die wordt uitgeleverd hoogt hem op — `bump patch` voor een correctie, `bump minor`
voor functionaliteit — en `bump major` wordt door het script geweigerd, omdat 1.0.0 bereiken een
besluit van de opdrachtgever is en geen rekensom.

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

## Versiedoelen

| Component | Versie |
|---|---|
| Node.js | 22 LTS |
| pnpm | 10.x (fase 0 noemde 9.x; 10 is wat de toolchain oploste) |
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

*Velnox™ is een handelsmerk van The Velnox Foundation. Velnox is vrije software onder de AGPLv3.*

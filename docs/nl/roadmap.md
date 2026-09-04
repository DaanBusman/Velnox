# Velnox — Implementatieroadmap

> **Vertaling.** Bron: [docs/roadmap.md](../roadmap.md) @ `2c2bcd1`.
> **Engels is leidend.** Bij verschil tussen deze tekst en de Engelse versie geldt de Engelse tekst.

**Status:** Fase 0, 1 en 2 afgerond. Fase 3–15 wachten op goedkeuring.

Elke afgeronde fase is geverifieerd in plaats van beweerd: `bash scripts/verify-stack.sh` toetst de
acceptatiecriteria tegen een draaiende stack — 29 controles over elke afhankelijkheid, de
migratiestatus, security headers, beide talen, het bronaanbod, het feit dat authenticatie anonieme
aanroepers daadwerkelijk weigert, dat de installatie na afloop gesloten is, en dat de datalaag niet
vanaf de host bereikbaar is. Het draait in CI bij elke wijziging.

Elke fase eindigt met dezelfde poort. Een fase is **niet** klaar voordat dit alles waar is:

1. `pnpm lint` en `pnpm typecheck` slagen zonder fouten.
2. `pnpm test` slaagt, inclusief de nieuwe tests van de fase.
3. `docker compose up --build` start de volledige stack en elke health check is groen.
4. De acceptatiecriteria van de fase zijn aantoonbaar gehaald — geverifieerd door het te draaien, niet
   door het te beweren.
5. De betreffende `docs/*.md`-bestanden zijn bijgewerkt.
6. Het werk is in logisch gescheiden commits vastgelegd.
7. Alles wat onvolledig is zit achter een feature flag en staat in `docs/known-gaps.md` — nooit getoond
   als werkende UI.

Inspanningsschattingen zijn relatieve maten (S/M/L/XL), geen beloften in kalendertijd.

---

## Phase 1 — Monorepo-bootstrap en draaiende stack · **L** · ✅ afgerond

pnpm workspaces, Turborepo, gedeelde TS-/ESLint-/Prettier-configuraties. NestJS api-skelet met
`/healthz`, `/readyz`, OpenAPI, globale validatiepipe, foutfilter, pino-logging met redactie. Next.js
web-skelet met de sidebar-shell, donkere modus en server-side API-reads (de proxyroute is geschrapt —
zie de wijziging uit fase 1 in tech-decisions.md ADR-003). Prisma-package met de eerste migratie
(alleen `system_settings`). Redis- en BullMQ-bedrading met een triviale ping-job. Compose-bestanden voor
dev en productie, Caddy, health checks, afhankelijkheidsvolgorde, named volumes. `.env.example` met elke
variabele gedocumenteerd. CI die lint, typecheck, test en build draait.

`packages/i18n` gekoppeld aan web en api: `next-intl`, `en`/`nl`-catalogi, taalkiezer, en CI-validators
voor de integriteit van de woordenlijst en de sleutelpariteit. Bedrading voor AGPL artikel 13:
`GET /api/v1/system/source`, het Over-scherm, `VELNOX_SOURCE_URL` en de ingesloten build-commit, plus een
licentiecontrole op afhankelijkheden in CI.

**Acceptatie:** `docker compose up --build` op een schone machine brengt zes gezonde services omhoog;
`https://localhost` toont de shell; `/api/v1/health` antwoordt via Caddy; een job in de wachtrij wordt
door de worker verwerkt en de voltooiing is zichtbaar; `/api/docs` toont OpenAPI; overschakelen naar
Nederlands verandert elke zichtbare tekst; CI faalt op een ontbrekende vertaalsleutel of een misvormde
rij in de woordenlijst; het Over-scherm toont versie, commit en een werkende bronlink.

## Phase 2 — Authenticatie, installatiewizard, RBAC-basis · **XL** · ✅ afgerond

Argon2id-hashing, JWT access + roterend refresh met hergebruikdetectie, CSRF double-submit,
snelheidsbegrenzing, security headers. Installatiewizard: `GET /setup/status`, `POST /setup/initialize`
dat de MSP-hoofdtenant, de systeemrollen en de eerste Super Administrator in één transactie aanmaakt en
daarna permanent gesloten is. Rechtencatalogus, rollen, roltoekenningen, `RequestContext`,
`@RequirePermission`-guard met bereikherleiding. Endpoints en UI voor login/logout/refresh/me.
Auditgebeurtenissen voor authenticatieacties. Entra ID OIDC-voorbereiding: configuratiemodel,
discovery-validatie, "verbinding testen", inlogknop achter een feature flag.

**MFA (optioneel, aanbevolen):** TOTP-aanmelding met bevestigen-voor-activeren, Argon2id-gehashte
eenmalige herstelcodes die één keer getoond worden, `sessions.mfa_satisfied_at` afgedwongen door een
globale guard, en het beleid `OPTIONAL` / `REQUIRED_FOR_PRIVILEGED` / `REQUIRED` op installatie- en
tenantniveau. De installatiewizard en de gebruikerslijst bevelen aanmelding voor bevoorrechte accounts
actief aan.

**Acceptatie:** een verse installatie toont de wizard, weigert een zwak wachtwoord, maakt precies één
beheerder aan en geeft 409 bij een tweede poging; nergens bestaan standaardcredentials; in- en uitloggen
werken; een verlopen access token wordt transparant ververst; een hergebruikt refresh token beëindigt de
sessiefamilie; een gebruiker zonder recht krijgt 403 en de weigering wordt geaudit; de testsuite voor de
rechtenmatrix slaagt. MFA: aanmelden kan niet worden afgerond zonder geldige code; een sessie die niet aan
een vereist beleid voldeed bereikt alleen aanmelden en uitloggen, geverifieerd tegen **elk** bestaand
endpoint in plaats van een steekproef; een herstelcode werkt precies één keer en het gebruik wordt geaudit
en gealarmeerd; de TOTP-seed wordt via de credential store opgeslagen en komt in geen enkele API-respons,
logregel of auditrecord voor.

## Phase 3 — Multi-tenancy · **L**

CRUD voor tenants en locaties. Prisma-tenancy-extensie met de regel dat een ontbrekende context een fout
gooit, en de expliciete uitweg `withSystemScope()`. Bereikbewuste roltoekenningen
(GLOBAL/TENANT/SITE/CLUSTER). Tenantkiezer in de bovenbalk (server-gevalideerd, nooit vertrouwd vanaf de
client). Testopzet voor cross-tenant-controles.

**Acceptatie:** MSP-hoofdgebruikers zien en beheren alle tenants; een tenantbeheerder ziet alleen de
eigen tenant en kan andere niet opsommen; de isolatiesuite slaagt voor lezen **en** schrijven op elke
tenant-gebonden resource die op dat moment bestaat, inclusief lijst-endpoints, filters en directe toegang
op id; een tenant-gebonden model bevragen zonder context gooit een fout in tests.

## Phase 4 — Proxmox-integratie en inventaris · **XL**

`packages/proxmox` met token- en ticket-authenticatie, TLS-vingerafdruk-pinning, herhaalpogingen en de
UPID-taakpoller. `packages/crypto` met envelope-encryptie en `DatabaseSecretStore`. Stromen voor het
toevoegen van een cluster of standalone node, inclusief de bevestigingsstap voor de vingerafdruk.
Discovery van clusterstatus, quorum, nodes, versies, repositories, abonnement, opslag, netwerk en
workloads. Inventaristabellen en UI: clusterlijst, nodelijst met kolommen voor gezondheid, versie en
updates, nodedetailpagina, VM-/containerinventaris. Geplande discovery via herhaalbare jobs.

**Ceph-inventaris** hoort bij deze fase en wordt niet uitgesteld naar het upgradewerk: `ceph_daemons`-rijen
voor MON/MGR/OSD/MDS/RGW met versie en status, PG-aantallen, OSD up/in-aantallen, MON-quorumgrootte,
gezette vlaggen en versiehomogeniteit. Ceph krijgt hier een UI-plek (tabblad op clusterdetail), zodat de
upgradefasen voortbouwen op inventaris die al tegen echte clusters bewezen is.

**Acceptatie:** een echt (of op fixtures gebaseerd) cluster kan met een API-token worden toegevoegd;
certificaat-pinning wordt afgedwongen en een afwijking faalt gesloten; node- en workloadinventaris vullen
zich en verversen volgens planning; PVE-versie en gezondheid zijn zichtbaar in de UI; credentials worden
versleuteld opgeslagen en geen endpoint geeft plat materiaal terug; discovery van een onbereikbare node
levert een vastgelegde fout op, geen stil succes. Ceph: daemons, versies en PG-status worden ontdekt en
getoond; een cluster waarop `noout` is blijven staan wordt getoond en gealarmeerd; een cluster zonder Ceph
toont helemaal geen Ceph-onderdelen in plaats van lege tegels.

## Phase 5 — Jobsysteem · **L**

Job-toestandsmachine, `job_steps`, `job_events`, `job_logs`, goedkeuringen. SSE-stroom met Redis pub/sub.
Annuleringsvlaggen en `AbortSignal`-bedrading. Verzoening na een crash bij het starten van de worker.
Gelijktijdigheidssleutels. Jobs-UI: lijst, filters, detail met live gebeurtenisstroom, annuleren, opnieuw
proberen.

**Acceptatie:** een langlopende job streamt live voortgang naar de browser; annuleren stopt hem op het
eerstvolgende veilige punt en legt `CANCELLED` vast; de worker halverwege afbreken laat de job verzoend
achter als `FAILED` met `worker_lost` in plaats van vast op `RUNNING`; twee muterende jobs op één cluster
kunnen niet gelijktijdig draaien; elke ongeldige toestandsovergang gooit een fout.

## Phase 6 — Updatebeheer · **M**

Update-inventaris per node (classificatie beveiliging / kernel / Proxmox), detectie van vereiste
herstart, updatebeleid, onderhoudsvensters (RRULE), uitvoering van een update op één node,
updatehistorie.

**Acceptatie:** openstaande updates worden per node getoond en correct geclassificeerd; een update op één
node draait als job met live uitvoer; vereiste herstart wordt gedetecteerd en getoond; beleid met een
onderhoudsvenster voert niets uit buiten dat venster; beleid met handmatige goedkeuring parkeert de job in
`waiting_approval`.

## Phase 7 — Rolling updates · **L**

Clusterbewuste orkestratie: guards voor quorum, Ceph en capaciteit, beoordeling van de migreerbaarheid van
workloads, live migratie waar mogelijk, onderhoudsmodus, herstart, wachten op terugkeer, nacontroles, en
dan pas de volgende node. Instelbare gelijktijdigheid met de centrale veiligheidsinvariant.

**Acceptatie:** een rolling update op een cluster van drie nodes werkt standaard strikt één node tegelijk
bij; de uitvoering weigert te starten op een reeds verminderd cluster; de quorum-invariant houdt stand
onder property-tests voor clustergroottes 1–15; een node die de validatie niet doorstaat stopt de
uitvoering en rapporteert `partially_succeeded`; workloads worden teruggemigreerd of expliciet
verantwoord.

## Phase 8 — Framework voor major upgrades (generiek) · **L**

Playbook-engine, stapregister, guard-evaluator, fasemodel (Discovery → Preflight → Herstel → Hercontrole →
Upgrade → Validatie → Rapport). Upgradeplannen en -doelen. Interface en register voor
herstelactie-plugins met planning van de wijzigingsset, goedkeuringsroutering en terugdraaien.
Rapportgeneratie.

**Samengestelde plannen:** `upgrade_plans.kind` met ouder/kind-volgorde, en `upgrade_targets` die zowel een
node als een Ceph-daemon kunnen aanwijzen — het structurele werk dat Phase 9A en 9B laat samenstellen.

**Acceptatie:** een playbook is als data gedefinieerd en wordt door de generieke runner uitgevoerd;
herstelactie-metadata stuurt de keuze tussen automatisch en goedkeuring; een samengesteld plan voert twee
kindplannen op volgorde uit en stopt de ouder wanneer een kind faalt; rapporten renderen voor zowel
node-gerichte als daemon-gerichte uitvoeringen. De genericiteitsclaim wordt hier niet beweerd — die wordt
*bewezen* in 9A en 9B, die twee structureel verschillende workflows op deze engine draaien zonder haar te
wijzigen.

## Phase 9A — Ceph major upgrade-workflow · **L**

Het Ceph-playbook: versiematrix-databestand dat bij het opstellen van het plan tegen het live cluster wordt
gevalideerd; repositorystap; `noout` zetten en opheffen met gegarandeerde opruiming bij falen en
annulering; daemonvolgorde MON → MGR → OSD → MDS → RGW met hervalidatie van de gezondheid tussen elke groep
en elke node met OSD's; `require-osd-release` pas verhoogd nadat alle OSD's de doelrelease melden;
verificatie van homogeniteit. Losstaande uitvoering (alleen Ceph upgraden) als volwaardige handeling.

**Acceptatie:** een plan weigert te bouwen wanneer draaiende release, doel en matrix niet overeenkomen, en
benoemt welke van de drie onverwacht is; de uitvoering weigert te starten tenzij Ceph `HEALTH_OK` is met
alle PG's active+clean en volledig MON-quorum; daemons worden strikt op volgorde herstart, één tegelijk,
met hervalidatie van de gezondheid daartussen; een onbekende `HEALTH_WARN` blokkeert in plaats van door te
gaan; `noout` wordt opgeheven bij succes, bij falen **en** bij annulering, geverifieerd door een test die de
uitvoering halverwege afbreekt; een cluster dat al middenin een upgrade zit (heterogene versies) is een
blokkade; het rapport toont de versie van elke daemon vóór en na.

## Phase 9B — PVE 8 → 9-workflow · **L**

Het PVE-playbook. Uitvoering van `pve8to9` en een geversioneerde parser met referentiebestandtests over
echte uitvoer van meerdere point releases. Repository-herstelacties (bookworm → trixie, omgang met
verouderde repositories, enterprise/no-subscription), pakket-herstelacties, detectie van blokkades in
opslag en netwerk. Canary-eerste nodevolgorde met expliciete bevestiging. Validatie na de upgrade tegen de
verwachtingen van PVE 9. Samenstelling met 9A voor Ceph-clusters.

**Acceptatie:** preflight levert gestructureerde PASS/WARNING/BLOCKER/UNKNOWN met behoud van de ruwe
uitvoer; onbekende regels gelden als blokkade en worden letterlijk getoond; een veilige
repository-herstelactie wordt toegepast, gevalideerd en start automatisch een hercontrole; een onveilige
herstelactie stopt voor goedkeuring en toont de exacte diff; blokkades kunnen door geen enkele UI-actie
worden omzeild; de eerste node is een canary en de uitvoering pauzeert ter bevestiging vóór de tweede; het
rapport bevat de nodestatus vóór en na. Voor een Ceph-cluster voert het samengestelde plan **eerst** de
Ceph-upgrade volledig uit en weigert het de PVE-upgrade te starten wanneer dat niet gelukt is.

## Phase 10 — Credentialrotatie · **M**

Wachtwoordgeneratie, crashbestendige volgorde PENDING → toepassen → verifiëren → ACTIVE, `chpasswd` via
SSH-stdin, verificatie met een nieuwe verbinding, rotatiebeleid en -planning, bereik per tenant, cluster en
node, afhandeling van `NEEDS_ATTENTION` en alarmering.

**Acceptatie:** rotatie voltooit en het nieuwe wachtwoord authenticeert; een gesimuleerde fout tussen
toepassen en verifiëren laat beide versies bewaard en het credential gemarkeerd, nooit verwijderd; de
volledige jobgebeurtenisstroom, logs, auditmetadata en elke API-respons worden gecontroleerd op afwezigheid
van elke deeltekst van het gegenereerde wachtwoord; noodinzage is een apart, zwaar geaudit recht.

## Phase 11 — VMware-migratieassistent · **L**

vCenter-/ESXi-adapter, discovery, compatibiliteitsbeoordeling, wizard voor doelselectie, plangeneratie, en
orkestratie van de eigen ESXi-import van PVE waar beschikbaar.

**Acceptatie:** hosts en VM's worden ontdekt met detail over CPU, RAM, schijven, NIC's, tools en
energiestatus; incompatibiliteiten (UEFI, vTPM, RDM, snapshots, stuurprogramma's) worden expliciet
getoond; een plan wordt gegenereerd met doelcluster, -node, -opslag en bridge-toewijzing; op PVE ≥ 8.2
draait een import als bijgehouden job; onder 8.2 vermeldt de UI de beperking in plaats van een knop aan te
bieden die niet kan werken.

## Phase 12 — Hyper-V-migratieassistent · **M**

WinRM-adapter, alleen-lezen PowerShell-discovery, VHDX-detectie, beoordeling van generatie, firmware en
dynamisch geheugen, plangeneratie, `qemu-img`-conversieworkflow met een duidelijk gelabelde stap met
handmatige tussenkomst.

**Acceptatie:** hosts en VM's worden ontdekt inclusief VHDX-paden, generatie en NIC's;
compatibiliteitswaarschuwingen zijn expliciet; een plan kan worden opgesteld en de automatiseerbare stappen
draaien als jobs; stappen die handmatige actie vereisen zijn als zodanig gelabeld en melden nooit uit
zichzelf succes.

## Phase 13 — UI-afwerking · **M**

Dashboardtegels, globaal zoeken, notificaties, bulkacties, opgeslagen filters, detailpanelen, kruimelpaden,
lege en fouttoestanden, toetsenbordnavigatie, toegankelijkheidscontrole, controle op donkere modus,
responsief gedrag.

**Acceptatie:** elk onderdeel uit de zijbalk in de opdracht leidt naar een echte pagina met echte data of
een eerlijke lege toestand; het dashboard toont de gespecificeerde tellers; bulkacties respecteren rechten
per item; contrast en focusvolgorde doorstaan een toegankelijkheidscontrole.

## Phase 14 — Installer en build-artefacten · **L**

`install.sh` (interactief en `--non-interactive`), automatische installatie van Docker en Compose,
secretgeneratie, idempotent herhalen, migraties, gezondheidsverificatie, tonen van de uiteindelijke URL.
`uninstall.sh` met expliciete bevestiging voor dataverwijdering. `scripts/build.sh` met doelen `tar`,
`installer`, `iso`, `dev`, `all`. Checksums, een manifest en een gegenereerde `THIRD-PARTY-NOTICES.md`.
live-build ISO-pijplijn met eerlijke voorcontrole. **Standaard air-gapped tar** (gebundelde
`docker save`-images) met een `--slim`-variant die uit een registry haalt.

**Acceptatie:** een schone Debian 12-VM zonder Docker gaat met één commando van `bash install.sh` naar een
werkende inlogpagina; opnieuw uitvoeren behoudt `.env` en data; de tar.gz pakt uit en installeert op een
tweede host **met uitgaand netwerk geblokkeerd**, mits Docker aanwezig is — en wanneer Docker op een
offline host ontbreekt zegt de installer dat vooraf in plaats van halverwege te falen; `uninstall.sh`
verwijdert nooit volumes zonder expliciete bevestiging; elk artefact levert checksums en third-party
notices mee; de ISO bouwt en start in een installer die een werkende appliance oplevert, of faalt met een
duidelijke melding — nooit een plaatsvervangend bestand.

## Phase 15 — Securityreview, tests, documentatie · **L**

Dreigingsmodel, `docs/security.md`, scannen van afhankelijkheden en containers, verificatie van security
headers, optionele PostgreSQL RLS-hardening, afstemmen van snelheidsbegrenzing, back-up-/hersteloefening,
sleutelrotatie-oefening. De documentatieset in het Engels afronden, `docs/nl/` synchroniseren, en zoeken
naar vastgelegde teksten. Testdekkingsgaten dichten.

**Acceptatie:** de volledige testsuite slaagt in CI, inclusief tenant-isolatie, rechtenmatrix, redactie,
quorum-invarianten en de garantie dat de Ceph-`noout`-vlag wordt opgeruimd; een gedocumenteerde
herstel-uit-back-upoefening slaagt op een verse host; een hoofdsleutelrotatie-oefening slaagt; er bestaat
geen zichtbare tekst buiten de taalcatalogi; elke term uit de woordenlijst wordt consistent gebruikt;
`docs/known-gaps.md` beschrijft elke resterende beperking accuraat.

---

## Onderbouwing van de opleveringsvolgorde

Phase 2–3 gaan vooraf aan al het Proxmox-werk omdat tenancy en RBAC grenzen zijn die pijnlijk zijn om
achteraf in te bouwen — elke latere tabel en elk later endpoint erft ze. Lokalisatie landt in Phase 1 om
dezelfde reden: teksten externaliseren is aan het begin bijna gratis en op elk later moment duur.

Phase 5 (jobs) gaat vooraf aan updates en upgrades omdat beide jobs zijn; ze eerder bouwen zou betekenen
dat de toestandsmachine twee keer gebouwd wordt. Phase 8 (generiek framework) gaat vooraf aan 9A en 9B,
zodat genericiteit door constructie bewezen wordt — twee structureel verschillende workflows op één
ongewijzigde engine — in plaats van achteraf beweerd.

**9A (Ceph) vóór 9B (PVE 8→9)** volgt de werkelijke beperking: een PVE major release levert een specifieke
Ceph-release en ondersteunt de vorige niet, dus Ceph moet geüpgraded worden terwijl het cluster nog op de
huidige PVE- en Debian-release draait. Ze in die volgorde bouwen betekent bovendien dat 9B 9A kan
samenstellen in plaats van andersom.

De installer landt in Phase 14 omdat die verpakt wat er is — maar de compose-stack uit Phase 1 is
doorlopend te draaien, zodat er nooit een periode is waarin het product niet gestart kan worden.

## Doorlopend werk in elke fase

Auditgebeurtenissen voor elke nieuwe muterende actie; OpenAPI actueel houden; tenancy- en rechtentests bij
elke nieuwe resource; **elke nieuwe zichtbare tekst in dezelfde commit toegevoegd aan `en.json` en
`nl.json`**; `.env.example` bijgewerkt bij elke nieuwe variabele; `docs/known-gaps.md` bijgewerkt wanneer
iets onvolledig wordt opgeleverd.

---

*Velnox™ is een handelsmerk van The Velnox Foundation.*

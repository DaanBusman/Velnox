# Velnox — Implementatieroadmap

> **Vertaling.** Bron: [docs/roadmap.md](../roadmap.md) @ `619264f`.
> **Engels is leidend.** Bij verschil tussen deze tekst en de Engelse versie geldt de Engelse tekst.

**Status:** Fase 0 tot en met 4 afgerond. Fase 5–15 wachten op goedkeuring.

Elke afgeronde fase is geverifieerd in plaats van beweerd: `bash scripts/verify-stack.sh` toetst de
acceptatiecriteria tegen een draaiende stack — 29 controles over elke afhankelijkheid, de
migratiestatus, security headers, beide talen, het bronaanbod, het feit dat authenticatie anonieme
aanroepers daadwerkelijk weigert, dat de installatie na afloop gesloten is, en dat de datalaag niet
vanaf de host bereikbaar is. Het draait in CI bij elke wijziging.

Twee verdere harnassen dekken wat een stackbrede sonde niet kan.
`scripts/verify-tenancy.sh` meldt zich aan als twee verschillende mensen en probeert de tenantgrens te
passeren via lijsten, filters, directe id-opvragingen en schrijfacties — 35 controles.
`scripts/verify-proxmox.sh` zet een fixture-Proxmox-API met een echt certificaat neer en doorloopt
daartegen de volledige toevoeg-en-uitlees-stroom — 50 controles. Beide vonden echte fouten die de
unittests niet konden vinden (ADR-030, ADR-031, ADR-032).

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

## Phase 3 — Multi-tenancy · **L** · ✅ afgerond

CRUD voor tenants en locaties. Prisma-tenancy-extensie met de regel dat een ontbrekende context een fout
gooit, en de expliciete uitweg `withSystemScope()`. Bereikbewuste roltoekenningen
(GLOBAL/TENANT/SITE/CLUSTER). Tenantkiezer in de bovenbalk (server-gevalideerd, nooit vertrouwd vanaf de
client). Testopzet voor cross-tenant-controles.

**Acceptatie:** MSP-hoofdgebruikers zien en beheren alle tenants; een tenantbeheerder ziet alleen de
eigen tenant en kan andere niet opsommen; de isolatiesuite slaagt voor lezen **en** schrijven op elke
tenant-gebonden resource die op dat moment bestaat, inclusief lijst-endpoints, filters en directe toegang
op id; een tenant-gebonden model bevragen zonder context gooit een fout in tests.

## Phase 4 — Proxmox-integratie en inventaris · **XL** · ✅ afgerond

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

## Phase 5A — Centrale ISO-bibliotheek · **XL**

Aangevraagd door de eigenaar op 27-09-2026, ingepland direct na fase 5 omdat elke handeling erin een
overdracht van meerdere gigabytes is — precies waar het jobsysteem voor bestaat.

Een centrale opslag op de Velnox-host voor ISO's en — sinds fase 5B voor Linux op cloud images
uitkwam — cloud-schijfimages, met drie bewegingen: een ISO naar de opslag van een cluster
duwen, er een van een cluster naar de bibliotheek halen, en er een op een cluster verwijderen. Overal
vriendelijke namen — `Windows11_25H2_Dutch` leest als "Windows 11 Version 25H2 Dutch" of "… Nederlands"
afhankelijk van de ingestelde Velnox-taal — afgeleid uit de bestandsnaam, met de mogelijkheid voor de
beheerder om het te corrigeren, want een bestandsnaam-ontleder is een gok en een zelfverzekerd fout
label is erger dan een eerlijk ruw label.

**Besluiten die met de eigenaar zijn genomen voordat er iets gebouwd is:**

- **Beide wegen naar binnen.** Velnox haalt van een URL *en* accepteert een upload uit de browser. De
  URL-weg is de goedkope en loopt in dezelfde richting als het duwen; de uploadweg is de weg die werkt
  op een netwerk zonder route naar buiten, en dat is de weg die geld kost: body-limieten in Caddy en
  Next, overdracht in stukken, en een voortgang die een verbroken verbinding overleeft.
- **Een eigen Docker-volume met een hard plafond.** Instelbaar, en een weigering zodra het vol is. De
  bibliotheek mag de schijf waarop PostgreSQL en Redis staan niet kunnen vullen: een volle schijf daar
  is geen mislukte upload maar een installatie die stilstaat.
- **Een eigen fase in plaats van een functie die ergens tussen geperst wordt.** Het is ook de eerste
  keer dat Velnox naar Proxmox *schrijft*. De worker heeft al als enige een route naar een node
  (ADR-009), dus architectonisch verandert er niets, maar het is een eerste keer en dat verdient de
  ADR die het krijgt.

**Acceptatie:** een ISO bereikt de opslag van een node en verschijnt in de eigen inhoudslijst van
Proxmox; diezelfde ISO teruggehaald naar de bibliotheek is byte-identiek aan wat er is geduwd; er een
verwijderen op het cluster haalt hem daar weg en laat de bibliotheekkopie ongemoeid; een halverwege
afgebroken overdracht laat aan geen van beide kanten een half bestand achter; de bibliotheek vol maken
wordt geweigerd met het plafond erbij, niet met een schijffout; elk scherm toont vriendelijke namen en
elke logregel de echte bestandsnaam.

## Phase 5B — Autoconfig-templates en onbeheerde VM-uitrol · **XL**

Aangevraagd door de eigenaar op 27-09-2026. Ingepland na fase 5 (jobs) en 5A (de ISO-bibliotheek),
omdat uitrollen een job is en de eerste stap ervan "staat de ISO op die node" is.

**Autoconfig**, een tabblad onder Beheer, bevat de templates. Een template staat op MSP-niveau of op
tenantniveau; een MSP-template is bruikbaar en te klonen door elke tenant eronder, tenzij anders
aangegeven. Een VM aanmaken betekent dan een template kiezen, waarna Velnox: controleert of de ISO op
de doelnode staat en hem uploadt als dat niet zo is, de VM aanmaakt, hem eventueel start en het
besturingssysteem zichzelf laat installeren, de aanvrager bericht zodra het klaar is, en een
PDF-verklaring van de installatie mailt.

### Windows — Autounattend.xml

De zeven velden van de eigenaar: hostname zonder domein; de editie (Home/Pro, of
Standard/Datacenter en hun Desktop Experience-varianten); een optionele productcode, en zonder die
code vraagt de VM er bij de eerste start om zoals hij dat onbeheerd ook zou doen, of wordt de vraag
overgeslagen waar de editie er geen nodig heeft; regionale en weergavetaalinstellingen; de lokale
accounts met hun wachtwoorden en per account een beheerdersvinkje, plus het wachtwoord van de
ingebouwde Administrator dat Windows Server altijd vereist; aparte vinkjes voor QEMU Guest Agent en
voor VirtIO; en MBR of GPT voor de systeemschijf, met GPT als aanbeveling waar het maar aangeboden
wordt.

Wat het toevoegen waard is, met de reden:

- **Vier taalvelden, niet één.** Unattend onderscheidt `UILanguage`, `SystemLocale`, `UserLocale` en
  `InputLocale`. Die samentrekken is waarom een Nederlandse installatie zo vaak eindigt met een
  Nederlands toetsenbord dat niemand wilde — Nederlandse beheerders typen overwegend op
  US-International.
- **Tijdzone**, wat geen taalinstelling is en het veld is dat logregels over een vloot vergelijkbaar
  maakt.
- **Hoe de editie werkelijk gekozen wordt.** Unattend kiest een image via `/IMAGE/INDEX` of
  `/IMAGE/NAME`, of wordt gestuurd door een KMS client setup key. Een editiekeuzelijst die de
  imagelijst van de ISO niet leest, is een lijst die stilletjes de verkeerde editie installeert.
- **Welke OOBE-schermen worden overgeslagen**, inclusief de Microsoft-accountvereiste op Windows 11 en
  de privacyschakelaars — allemaal schermen die iemand anders op een server wegklikt.
- **Aantal keer automatisch aanmelden**, want het installeren van de guest agent en VirtIO vereist één
  aangemelde ronde. Dat moet daarna terug: een VM die blijft automatisch aanmelden is een VM zonder
  wachtwoord.
- **Commando's bij de eerste aanmelding**, want daar draaien die agent- en VirtIO-installaties.
- **Werkgroepnaam**, RDP met de bijbehorende firewallregel, het energieplan, en of sluimerstand blijft.
- **Windows Update tijdens OOBE of uitgesteld** — het verschil tussen een VM die na tien minuten klaar
  is en een die er een uur over doet.

### Ubuntu en Debian

De vijf van de eigenaar: hostname; de versie; regionale en weergavetaalinstellingen; het root-account
en optioneel extra root-accounts; en de mirror, met een aanbeveling van Velnox.

**De aanbevolen mirror, uitgesproken in plaats van aan een meting overgelaten:** voor Debian
`deb.debian.org` — het CDN, dat uitkomt bij iets in de buurt van de host, nooit achterloopt, en een
met de hand gekozen landmirror in vrijwel alle gevallen verslaat. Voor Ubuntu
`mirror://mirrors.ubuntu.com/mirrors.txt`, de officiële geografisch kiezende vorm. Een Nederlandse
installatie die een vaste host wil kan `nl.archive.ubuntu.com` of `ftp.nl.debian.org` krijgen, als
keuze en niet als standaard, want een vaste mirror is een enkel punt van falen dat het CDN niet heeft.

Verder het toevoegen waard: SSH-sleutels en of wachtwoordauthenticatie überhaupt mag;
`PermitRootLogin`; pakketten bij de eerste start, met `qemu-guest-agent` erbij; tijdzone, taal en
toetsenbord opnieuw als aparte velden; schijfindeling en swap; vast adres of DHCP; een APT-proxy; en
unattended-upgrades.

**Besloten met de eigenaar op 27-09-2026:**

- **Linux wordt uitgerold vanaf cloud images, niet vanaf een installatie-ISO.** cloud-init stuurt geen
  ISO-installatie — de installer van Ubuntu neemt `autoinstall` en die van Debian `preseed` — en de
  eigenaar liet de keuze aan de bouwer. Cloud images winnen op elk punt dat hier telt: Proxmox
  ondersteunt ze rechtstreeks (`qm importdisk`, `--ciuser`, `--sshkeys`, `--ipconfig0`,
  `--cicustom`), een VM is binnen seconden bruikbaar in plaats van na een installatieronde, en het
  resultaat is elke keer identiek omdat er niets vragen beantwoordt. Het gevolg voor fase 5A: **de
  bibliotheek bevat cloud images naast ISO's**, en "staat hij op de node" betekent voor Linux het
  schijfimage en voor Windows de ISO. Windows blijft ISO plus Autounattend.xml, want Microsoft levert
  geen cloud image.
- **Een sudo-gebruiker met een sleutel is de standaard; root-login is een optie, uit tenzij gekozen.**
  Extra accounts zijn sudo-gerechtigde gebruikers, geen extra roots.
- **SSH-toegang is een schakelaar op de template**, standaard aan: `openssh-server` geïnstalleerd en
  ingeschakeld, SSH-sleutels geplaatst voor elk account, wachtwoordauthenticatie uit tenzij de
  template die aanzet, en — waar het image een firewall meelevert — poort 22 daarvoor open. De meeste
  cloud images hebben de server al; de schakelaar maakt dat een garantie in plaats van een aanname
  over het image.

### Bericht en installatieverklaring

Hiervan bestaat nog niets: er is geen maildienst, geen notificatiesysteem en geen PDF-generatie in het
product. Fase 13 noemt notificaties als UI-afwerking, en dat is niet hetzelfde als bezorging. Deze
fase draagt dus een eerste keer: SMTP-configuratie, een notificatiekanaal per ontvanger, en een
PDF-renderer.

**De inloggegevens in die PDF zijn het deel om te besluiten, niet om stil te implementeren.** De eigen
regels van Velnox zeggen dat een wachtwoord nooit in een log staat, nooit in job-uitvoer, en nooit de
frontend bereikt tenzij een expliciete break-glass-functie dat vereist. Een gemailde PDF met lokale
beheerderswachtwoorden is een blijvende kopie van precies dat in een mailbox, op een relay, en in wat
die beide back-upt — en gewone SMTP is niet end-to-end versleuteld.

**Besloten met de eigenaar:** de mail draagt de installatieverklaring en **nooit de inloggegevens in
leesbare vorm**. Die gaan een van twee wegen, per template gekozen:

- **Alleen in Velnox** — de standaard. Een link naar de installatie, waar het tonen van de
  wachtwoorden een vastgelegde handeling is achter `clusters.manage`, en het tonen verloopt.
- **Een versleutelde PDF** — AES-256, waarvan het wachtwoord **niet in dezelfde mail** staat. Het
  wordt één keer in Velnox getoond aan wie de uitrol startte, of door een beheerder op de template
  ingesteld. Een beveiligde bijlage met het wachtwoord in de tekst is een onbeveiligde bijlage met
  extra stappen.

**Acceptatie:** een MSP-template is zichtbaar voor een tenant eronder en een tenanttemplate niet naar
boven; een MSP-template klonen levert een onafhankelijke kopie; een template die als privé is
gemarkeerd wordt aan niemand anders aangeboden. Uitrollen vanaf een template zet de ISO op de node als
hij ontbreekt, maakt de VM aan met de schijfindeling die de template voorschrijft, en de gast
installeert zichzelf zonder één toetsaanslag. Een Windows-template zonder productcode levert een VM
die erom vraagt; een met code een die dat niet doet. Wachtwoorden en productcodes worden met
envelope-encryptie opgeslagen en komen in geen log, geen job-uitvoer, geen API-antwoord en geen
mailtekst voor; het wachtwoord van een versleutelde PDF reist nooit mee in de mail die de PDF draagt.
Een Linux-VM met de SSH-schakelaar aan accepteert bij de eerste start een login met sleutel en weigert
een login met wachtwoord, tenzij de template dat toestond. Een
mislukte installatie laat geen half aangemaakte VM achter. De verklaring noemt de hostname, het adres,
de duur en de template, en het bericht komt één keer aan.

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

**Een fase als afgerond markeren is wat de versie verzet.** De markering `✅ complete` op de
koppen hierboven wordt gelezen door `scripts/version.mjs`: onder 1.0.0 is het minor-nummer het
fasenummer, dus fase N afronden is wat het product `0.N.0` maakt. `pnpm run validate:version` faalt
wanneer de twee het oneens zijn, en `version:phase` weigert vooruit te lopen op dit bestand. Markeer
het hier, in de wijziging die de fase afmaakt.

**Beheerdersdocumentatie, in dezelfde fase die de functie oplevert.** Elke fase die iets toevoegt
dat een beheerder doet, voegt de bijbehorende handleiding toe, in het Engels en het Nederlands, aan
de gidsen die in het product zelf meegaan — niet aan een backlog. Een fase is niet af zolang de
enige manier om te leren hoe je gebruikt wat ze heeft gebouwd, het lezen van de broncode is. De
gidsen zijn taakgericht (*een cluster aanmaken*, *een node toevoegen*) en staan los van de
referentiedocumenten, die uitleggen hoe het systeem in elkaar zit; zie ADR-026 in
[tech-decisions.md](tech-decisions.md).

| Fase | Handleiding die ze moet opleveren |
|---|---|
| 3 | Een klanttenant aanmaken; een locatie toevoegen; een toekenning onder globaal bereik brengen |
| 4 | Een cluster toevoegen; een node toevoegen; infrastructuurcredentials opslaan; inventaris lezen |
| 5 | Jobs volgen, annuleren en goedkeuren |
| 6 | Updates beoordelen en toepassen |
| 7–9 | Een rolling update uitvoeren; een major upgrade uitvoeren; de workflows voor Ceph en PVE 8 → 9 |
| 10 | Een rotatiebeleid instellen; noodtoegang tot een wachtwoord |
| 11–12 | Een VMware- of Hyper-V-migratie analyseren en uitvoeren |

---

*De naam en het logo van Velnox worden gebruikt door The Velnox Foundation. Er is geen merk geregistreerd of geclaimd; de AGPLv3 verleent daar geen rechten op.*

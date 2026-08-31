# Velnox — Technisch risicoregister

> **Vertaling.** Bron: [docs/risks.md](../risks.md) @ `5fd136a`.
> **Engels is leidend.** Bij verschil tussen deze tekst en de Engelse versie geldt de Engelse tekst.

**Status:** Phase 0. Risico's zijn gerangschikt op *verwachte schade*, niet op waarschijnlijkheid
alleen: dit product bewaart root-credentials van productie-hypervisors van andere bedrijven en herstart
ze.

Score: **Impact** (1–5) × **Waarschijnlijkheid** (1–5) = **Risico**. Alles ≥ 12 heeft een mitigatie
nodig die in dezelfde fase landt als de functie die het risico veroorzaakt.

---

## Niveau 1 — kan klantinfrastructuur vernietigen of klantsecrets lekken

### R-01 · Cross-tenant datalek (Impact 5 × Waarschijnlijkheid 3 = **15**)
Eén vergeten `where: { tenantId }` toont de nodes, credentials of het auditspoor van klant A aan klant
B. Dit is de ergst denkbare uitkomst voor een MSP-hulpmiddel.

**Mitigatie:** gelaagde verdediging, geen zorgvuldigheid. (a) De Prisma client-extensie injecteert het
tenantfilter op elk tenant-gebonden model en **gooit een fout** wanneer er geen requestcontext is;
(b) een expliciete RBAC-guard met bereikherleiding; (c) een ESLint-verbod op ruwe SQL; (d) een
CI-blokkerende testsuite die voor *elke* tenant-gebonden resource controleert dat een gebruiker van
tenant A 403/404 krijgt bij lezen **en** schrijven van een object van tenant B — inclusief geneste
routes, lijst-endpoints, filters, sorteringen en jobdoelen; (e) PostgreSQL RLS op de meest risicovolle
tabellen als hardening in Phase 15.
**Restrisico:** ruwe SQL in een toegestaan bestand blijft een gat. Elke uitzondering vereist review.

### R-02 · Secretlek via logs, joboutput of API-responses (5 × 3 = **15**)
Wachtwoorden belanden veel makkelijker dan mensen verwachten in `ps`-uitvoer, shellhistorie,
`apt`-logs, PVE-taaklogs, foutmeldingen en stack traces.

**Mitigatie:** secrets nooit als procesargument — `chpasswd` krijgt ze op stdin over het SSH-kanaal;
getypeerde `JobEvent`-payloads in plaats van ruwe uitvoer; pino-redactie plus een waardevergelijkende
sweep vóór elke log-, gebeurtenis- of auditinvoeging; de API heeft **geen code path** dat plat materiaal
teruggeeft; een aparte test controleert dat de volledige gebeurtenisstroom, logs en API-responses van een
rotatiejob geen enkele deeltekst van het gegenereerde wachtwoord bevatten.
**Restrisico:** een externe bibliotheek die een verbindings-URL logt. Ondervangen door redactie bij de
uitvoer.

### R-03 · Rolling update brengt een cluster onder quorum (5 × 3 = **15**)
Eén node te veel herstarten verandert een onderhoudsvenster in een storing, en Ceph voegt een tweede,
onafhankelijk quorum toe dat gerespecteerd moet worden.

**Mitigatie:** de invariant staat op één plek, niet in elke stap — op geen enkel moment mag het aantal
niet-beschikbare stemmende nodes groter zijn dan `⌊(n-1)/2⌋`. Standaard gelijktijdigheid 1. Weigeren te
starten op een reeds verminderd cluster. Quorum en Ceph-gezondheid opnieuw controleren *vóór elke node*,
niet eenmalig bij aanvang. `concurrency_key = cluster:<id>` met een partiële unieke index maakt twee
gelijktijdige jobs op één cluster onmogelijk, ook over meerdere workers. Property-based tests over
clustergroottes 1–15 controleren dat de invariant geldt voor elk schema dat de planner kan opleveren.

### R-04 · Major upgrade maakt een node onbruikbaar (5 × 3 = **15**)
PVE 8 → 9 overschrijdt een Debian-hoofdrelease. Een half voltooide `dist-upgrade`, een verkeerde
repository of een herstart in een kapotte kernel betekent een bezoek ter plaatse.

**Mitigatie:** blokkades stoppen de uitvoering — Velnox gaat nooit "toch door"; niet-geparseerde
`pve8to9`-uitvoer geldt als blokkade; één node upgraden en dan **expliciet laten bevestigen** voor de
rest (de eerste node is standaard een canary); configuratiebestanden worden geback-upt vóór wijziging;
annuleren breekt nooit een lopende `dist-upgrade` af; validatie na de upgrade moet slagen voordat de
volgende node begint. Velnox kan een Debian-hoofdupgrade niet terugdraaien — dat staat in de UI vóór de
operator bevestigt, en een PBS- of hostback-up is een gedocumenteerde voorwaarde.
**Restrisico:** werkelijk onherstelbare mislukkingen blijven mogelijk. Eerlijke documentatie in plaats
van een valse belofte van terugdraaien.

### R-04b · Ceph-upgrade beschadigt de opslaglaag (5 × 3 = **15**)
Een Ceph-release-upgrade herstart elke storage-daemon in het cluster. OSD's te snel herstarten, doorgaan
op een verminderd cluster, of `require-osd-release` verhogen voordat alle OSD's geconvergeerd zijn, kan
placement groups offline halen — waardoor elke VM op die opslag tegelijk stopt, over alle nodes heen.
Erger nog: het is een tijdlang stil, want PG's degraderen voordat ze onbeschikbaar worden.

**Mitigatie:** strikte daemonvolgorde (MON → MGR → OSD → MDS → RGW) met hervalidatie van de gezondheid
tussen elke groep *en* elke node met OSD's, nooit een gezamenlijke herstart; `HEALTH_OK` plus alle PG's
`active+clean` plus volledig MON-quorum verplicht vóór aanvang en doorlopend hercontroleerd; een
capaciteitsguard die borgt dat het cluster één failure domain kan missen; een cluster met heterogene
daemonversies is een blokkade en niet iets om te hervatten; onbekende `HEALTH_WARN`-statussen blokkeren
in plaats van door te gaan.
**Restrisico:** een beschadigd Ceph-cluster herstellen is echt expertwerk. Velnox stopt en rapporteert;
het probeert geen slimme automatische reparatie.

### R-04c · `noout` blijft staan na afgebroken Ceph-onderhoud (4 × 4 = **16**)
`noout` onderdrukt automatisch herbalanceren. Blijft die vlag staan na een mislukte of geannuleerde run,
dan lijkt het cluster gezond terwijl het stilzwijgend geen zelfherstel meer heeft — tot weken later een
schijf sterft en er niets hersteld wordt. Dit is de klassieke Ceph-tijdbom, en een orkestrator
veroorzaakt hem *eerder* dan een mens, omdat een gecrasht proces zijn opruiming nooit uitvoert.

**Mitigatie:** het opruimen van de vlag is een gegarandeerde stap op elk uitgangspad — succes, falen en
annulering — en geen stap in het gelukkige pad; bij het herstarten van de worker controleert de verzoener
op vlaggen die door een weesjob zijn gezet en heft die op of escaleert; `ceph_flags` wordt bij elke
discovery geïnventariseerd en gealarmeerd, ongeacht welk hulpmiddel de vlag zette, inclusief een mens op
de commandoregel. Een test breekt de run halverwege af en controleert dat de vlag is opgeheven.

### R-05 · Verlies van `MASTER_ENCRYPTION_KEY` (5 × 2 = **10**, maar onherstelbaar)
Zonder de hoofdsleutel is elk opgeslagen credential permanent onleesbaar.

**Mitigatie:** de installer toont een nadrukkelijke waarschuwing en de locatie van de sleutel; de
back-updocumentatie begint ermee; `/readyz` faalt direct bij een sleutel die bestaande rijen niet kan
ontsleutelen (in plaats van later stilletjes fouten te geven); sleutelversionering plus een
`rewrap`-operatie ondersteunt rotatie en herstelrepetities. Een toekomstige KMS-backend heft dit enkele
faalpunt op.

---

## Niveau 2 — waarschijnlijk merkbaar tijdens de implementatie

### R-06 · Uitvoerformaat van `pve8to9` verandert per release (4 × 4 = **16**)
Het is een op mensen gerichte CLI, geen stabiele API. Een parser die een onbekende regel stilzwijgend
laat vallen, laat een echte blokkade door.

**Mitigatie:** ernst `UNKNOWN` geldt als blokkade die menselijke beoordeling vereist; de parser is
geversioneerd en `parser_version` staat op elke controle; de ruwe uitvoer wordt altijd bewaard; een
suite met referentiebestanden dekt echte uitvoer van meerdere PVE-point releases; de UI toont
ongeparseerde regels letterlijk in plaats van ze te verbergen.

### R-07 · Self-signed TLS van Proxmox (4 × 5 = **20** bij naïeve aanpak)
De overweldigend gangbare kortere weg is `rejectUnauthorized: false`, waarmee elke verbinding van Velnox
naar een node over een klant-WAN vatbaar wordt voor MITM — terwijl root-credentials worden gedragen.

**Mitigatie:** er bestaat geen onveilige modus in de code. Trust-on-first-use met de getoonde
vingerafdruk ter expliciete bevestiging, vastgelegd op de rij, geverifieerd bij elke verbinding; een
afwijking is een harde fout plus een melding; een eigen CA-bundel wordt ondersteund als betere optie. De
TOFU-bevestiging wordt geaudit met vastlegging van de vingerafdruk.

### R-08 · Vertrouwen in de SSH-hostsleutel (4 × 4 = **16**) — dezelfde klasse als R-07, dezelfde aanpak
TOFU met expliciete bevestiging, vastgelegde vingerafdruk, afwijking is een harde fout. Nergens een
equivalent van `StrictHostKeyChecking=no`.

### R-09 · Hyper-V heeft geen REST-API (3 × 5 = **15** voor de planning, niet voor de veiligheid)
Discovery vereist WinRM/PowerShell-remoting met NTLM of Kerberos; VHDX-overdracht vereist SMB- of
SSH-bereikbaarheid die veel omgevingen een Linux-appliance niet geven.

**Mitigatie:** v1 eerlijk afbakenen — volledige discovery en planning, plus een overdrachtsstap **met
handmatige tussenkomst** die als zodanig in de UI staat. Geen nepautomatisering, geen nep-voortgangsbalk.
Documenteer precies welke netwerkpaden en rechten volledige automatisering zou vereisen, zodat het later
toegevoegd kan worden.

### R-10 · VMware-overdracht is een groot probleem om zelf te bouwen (3 × 4 = **12**)
Een eigen VDDK/OVF-pijplijn schrijven kost maanden en levert een supportlast op.

**Mitigatie:** de eigen ESXi-import storage van Proxmox VE orkestreren (PVE ≥ 8.2) in plaats van die na
te bouwen. Onder 8.2: discovery, compatibiliteitsbeoordeling en een gedocumenteerde handmatige
procedure. De adapterinterface houdt een toekomstige eigen pijplijn additief.

### R-11 · ISO-bouw vereist rechten die Docker Desktop niet kan geven (3 × 5 = **15** voor de planning)
`live-build` vereist loop devices en verhoogde rechten; het draait niet op Docker Desktop voor Windows of
macOS.

**Mitigatie:** `build-iso.sh` controleert vooraf op een Linux-host met de vereiste mogelijkheden en
**faalt met een duidelijke melding** in plaats van een niet-opstartbaar bestand te maken. De tar.gz- en
zelfuitpakkende-installerdoelen — die het eigenlijke acceptatiecriterium van installeren op een schone
Debian-machine dekken — kennen die beperking niet en worden eerst opgeleverd.

### R-12 · Job- en wachtrijstatus lopen uiteen na een crash (3 × 4 = **12**)
Een worker die halverwege een job wordt afgebroken laat een `RUNNING`-rij zonder wachtrij-item achter,
of een wachtrij-item zonder rij.

**Mitigatie:** PostgreSQL is de bron van waarheid; bij het starten verzoent de worker beide richtingen —
weesjobs met status `RUNNING` ouder dan de hartslagdrempel worden `FAILED` met een expliciete fout
`worker_lost` (nooit stil opnieuw geprobeerd, omdat een half toegepaste upgrade niet blind herhaald mag
worden); stappen zijn idempotent, zodat een operator veilig kan hervatten.

---

## Niveau 3 — kwaliteits-, oplever- en operationele risico's

| ID | Risico | Score | Mitigatie |
|---|---|---|---|
| R-13 | **Omvang.** 16 fasen, ~9 grote subsystemen, nu inclusief Ceph-upgrades, MFA en twee talen. De realistische faalwijze is een breed, ondiep, half werkend product. | 4×4=16 | Fasepoorten met expliciete acceptatiecriteria; elke fase moet aantoonbaar werken, getest en gedocumenteerd zijn voordat de volgende begint. Feature flags verbergen onvolledige subsystemen in plaats van nep-UI op te leveren. De beslissingen van 2026-08-31 vergrootten de omvang met ruwweg één fase (9A) plus doorlopend i18n-werk — verwerkt in de roadmap in plaats van stilzwijgend geabsorbeerd. |
| R-14 | Testen tegen echte Proxmox vereist hardware die er tijdens de ontwikkeling misschien niet is. | 3×4=12 | Een Proxmox-mock op basis van opgenomen echte API-responses voor unit- en integratietests, plus een gedocumenteerde handmatige verificatielijst tegen een echt cluster per fase. Fixtures worden als fixture gelabeld — de UI toont fixture-data nooit als live. |
| R-15 | Verkeerd geconfigureerde OIDC/Entra sluit iedereen buiten. | 4×3=12 | Lokale noodtoegang kan niet door SSO-configuratie worden uitgeschakeld; een "verbinding testen"-stroom valideert discovery, redirect-URI en claims voordat SSO aangezet kan worden; wijzigingen worden geaudit. |
| R-16 | Langlopende SSH-sessies die door klantfirewalls worden verbroken tijdens een upgrade. | 3×4=12 | Keepalives; losgekoppelde uitvoering met een hervatbaar markeerbestand op de node, zodat na herverbinden bepaald kan worden wat voltooid is; nooit aannemen dat een mislukking "niet toegepast" betekent. |
| R-17 | Goedkeuringsmoeheid — operators die goedkeuren zonder te lezen. | 3×4=12 | Goedkeuringen tonen de exacte diff van de wijzigingsset, geen algemene vraag; riskante herstelacties zijn visueel onderscheidend; optioneel vierogenprincipe; elke goedkeuring wordt geaudit met de hash van de wijzigingsset. |
| R-18 | Ontwikkeling op Windows, uitrol op Linux (regeleindes, rechten, padscheidingstekens). | 2×5=10 | `.gitattributes` die LF afdwingt voor shellscripts; alle shellscripts in CI gecontroleerd met shellcheck; containerbuilds zijn de waarheid voor alles wat padgevoelig is. |
| R-19 | Tijdzoneafhandeling in onderhoudsvensters. | 3×3=9 | RRULE plus IANA-tijdzone opslaan; server-side evalueren in de eigen zone van het venster; nooit in die van de browser. |
| R-20 | Groei van het auditlog versus onveranderlijkheid. | 2×4=8 | Alleen-toevoegen-trigger; hashketen; opschonen op bewaartermijn door een aparte rol, zelf geaudit; gedocumenteerde export vóór opschonen. |
| R-21 | Toeleveringsketen (gecompromitteerde npm-afhankelijkheid) in een hulpmiddel dat root-credentials draagt. | 5×2=10 | Lockfile in versiebeheer; `pnpm audit` en een SCA-poort in CI; base images vastgezet op digest; minimaal afhankelijkhedenoppervlak in `packages/crypto` en `packages/remote-exec`; geen post-install scripts voor nieuwe afhankelijkheden zonder review. |
| R-22 | **MFA sluit de laatste beheerder buiten.** `REQUIRED` aanzetten terwijl de enige Super Administrator geen of een verloren authenticator heeft, maakt de installatie onbeheerbaar. | 4×3=12 | Aanmelden moet met een werkende code bevestigd worden voordat een factor actief wordt, zodat een half afgeronde inrichting nooit de afgedwongen factor kan worden; herstelcodes worden bij het aanmelden gegenereerd en getoond, en het beleid kan pas naar `REQUIRED` tenzij minstens één Super Administrator een bevestigde factor **en** ongebruikte herstelcodes heeft; een gedocumenteerde offline resetprocedure via de database bestaat en wordt zelf geaudit. |
| R-23 | **Vertaaldrift.** Nederlandse documenten verouderen stilletjes — erger dan ze niet hebben, omdat een lezer het niet kan zien. | 3×5=15 | Elk bestand in `docs/nl/` legt de git-hash vast van de Engelse bron waaruit het vertaald is; CI waarschuwt (blokkeert nooit) wanneer de Engelse tegenhanger is gewijzigd; de kop van elk Nederlands document vermeldt dat Engels leidend is. UI-teksten kennen een strengere regel: een ontbrekende of overtollige sleutel laat de build **falen**. |
| R-24 | **Licentie van een afhankelijkheid niet compatibel met AGPLv3**, laat ontdekt, wat een herbouw van een UI- of cryptocomponent afdwingt. | 4×2=8 | Een licentiecontrole in CI bij elke toegevoegde afhankelijkheid vanaf Phase 1, geen audit in Phase 15; componentbibliotheek gekozen op een permissieve licentie met meegeleverde broncode (shadcn/ui, MIT); `THIRD-PARTY-NOTICES.md` bij de build uit het lockfile gegenereerd zodat het beeld nooit verouderd is. |
| R-25 | **De Ceph/PVE-versiematrix veroudert** naarmate upstream-releases opschuiven, waardoor plannen onjuist worden in plaats van te weigeren. | 4×3=12 | De matrix is data, geversioneerd, en vastgelegd op elk plan (`version_matrix_id`) zodat oude rapporten interpreteerbaar blijven; ze wordt *bij het opstellen van het plan tegen het live cluster geverifieerd*, en onenigheid tussen draaiende release, doel en matrix weigert het plan onder vermelding van welke van de drie onverwacht is. Velnox gokt nooit over versiecompatibiliteit. |

---

## Genomen beslissingen — 2026-08-31

| # | Vraag | Beslissing | Effect |
|---|---|---|---|
| 1 | Ceph-upgrades | **In scope.** Apart playbook, samengesteld vóór de PVE major upgrade. | Nieuwe Phase 9A; Ceph-inventaris naar voren gehaald in Phase 4; nieuwe risico's R-04b, R-04c, R-25. |
| 2 | MFA | **Optioneel maar aanbevolen.** TOTP + herstelcodes, drie beleidsniveaus, `OPTIONAL` als standaard. | Toegevoegd aan Phase 2; nieuw risico R-22. |
| 3 | Air-gapped installatie | **Ja** — gebundelde images zijn het standaard tar-artefact, met een `--slim`-variant ernaast. | Acceptatie in Phase 14 omvat nu een installatie met uitgaand netwerk geblokkeerd. |
| 4 | PBS | **Uitgesteld** tot na v1. Het framework blijft klaar voor een PBS-playbook. | Vastgelegd in known-gaps.md. |
| 5 | Documentatietaal | **Engels + Nederlands**, met een vertaalklare woordenlijst. Engels is leidend. | Nieuwe `packages/i18n`, `docs/i18n.md`, `docs/nl/`; i18n verplaatst naar Phase 1; nieuw risico R-23. |
| 6 | Licentie | **AGPLv3.** | Naleving van artikel 13 is een productfunctie in Phase 1; licentiepoort in CI; nieuw risico R-24; `TRADEMARK.md` scheidt merken van de licentie. |

## Nog openstaande vragen

1. **Alleen agentloos?** Al het bovenstaande gaat ervan uit dat er geen Velnox-agent op beheerde nodes
   staat. Een optionele agent zou R-16 (verbroken SSH-sessies) en herstart-overleving netjes oplossen.
   Buiten scope tenzij gevraagd — het is een aanzienlijke toevoeging, dus een expliciete beslissing waard
   in plaats van geleidelijke verschuiving.
2. **Handelsmerkcontact.** `TRADEMARK.md` heeft vóór publicatie een echt contactadres nodig voor
   toestemmingsverzoeken.
3. **Auteursrechthouder.** `NOTICE` vermeldt nu "Copyright (C) 2026 The Velnox Foundation". Bevestig dat
   dit de bedoelde houder is, of noem in plaats daarvan individuele bijdragers.

---

*Velnox™ is een handelsmerk van The Velnox Foundation.*

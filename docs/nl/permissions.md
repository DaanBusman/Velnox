# Rollen en rechten

> **Vertaling.** Bron: [docs/permissions.md](../permissions.md) @ `PENDING`.
> **Engels is leidend.** Bij verschil tussen deze tekst en de Engelse versie geldt de Engelse tekst.

**De volledige specificatie van wat elke rol toekent.** Dit is de referentie; het scherm
**Rollen & rechten** in Velnox toont de rollen zoals ze in *jouw* database staan, wat op een verse
installatie hetzelfde is en kan gaan afwijken zodra rollen bewerkbaar worden.

Voor de taken — een rol toekennen, een rol intrekken, een account uitschakelen — zie
[Gebruikers en toegang beheren](managing-access.md).

---

## Hoe rechten werken

Een recht is één werkwoord op één soort object, benoemd als `object.actie`:

- **`read`** ziet.
- **`manage`** maakt aan, wijzigt en verwijdert.
- **`execute`** start werk tegen echte infrastructuur.

De scheiding tussen `manage` en `execute` is bewust. Een upgrade plannen en er een uitvoeren tegen
het productiecluster van een klant zijn verschillende niveaus van vertrouwen, en een rol kan het
eerste hebben zonder het tweede.

Rechten worden niet aan mensen toegekend. Ze worden toegekend aan **rollen**, en rollen worden
toegekend aan accounts. Er is geen manier om één account één extra recht te geven — bewust, want een
rechtenverzameling die per persoon is samengesteld is een rechtenverzameling die niemand kan
beoordelen.

De catalogus is een bevroren lijst in de broncode. Een recht dat er niet in staat, bestaat niet: er
een toevoegen is een codewijziging plus een datamigratie, nooit een invoerscherm tijdens runtime,
zodat de verzameling dingen die aan een rol toekenbaar zijn altijd zichtbaar is in een diff.

---

## Bereiken

Elke toekenning draagt een bereik, en dekt dat bereik en alles daaronder:

```
GLOBAL  →  TENANT  →  SITE  →  CLUSTER
```

Een toekenning op `TENANT` dekt elke locatie, elk cluster en elke node in die tenant. Een toekenning
op `CLUSTER` dekt alleen dat cluster.

**`GLOBAL` is alleen toekenbaar aan leden van de MSP-hoofdtenant** — je eigen organisatie. De
beheerder van een klant kan geen globale toekenning hebben, welke rol hij ook krijgt.

Tot multi-tenancy in fase 3 landt is er één tenant, dus in de praktijk is elke toekenning vandaag
globaal en hebben de bereiken daaronder nog niets om naar te wijzen.

---

## De zeven systeemrollen

Aangemaakt door de installatiewizard. Rollen met **alleen MSP** zijn alleen toekenbaar aan accounts
in je eigen organisatie.

| Rol | Sleutel | Alleen MSP | Kent toe | Voor |
|---|---|:-:|--:|---|
| MSP Super Administrator | `msp_super_administrator` | ja | 34 van 34 | De eerste beheerder. De enige rol met installatiebrede instellingen. |
| MSP Administrator | `msp_administrator` | ja | 33 | Runt de MSP dagelijks, inclusief mensen. Geen installatie-instellingen. |
| MSP Engineer | `msp_engineer` | ja | 27 | Runt het landschap. Geen identiteitsbeheer, geen auditlog. |
| MSP Read Only | `msp_read_only` | ja | 18 | Ziet alles over alle tenants, wijzigt niets. |
| Tenant Administrator | `tenant_administrator` | nee | 32 | Volledige controle binnen één tenant, inclusief de mensen van die tenant. |
| Tenant Operator | `tenant_operator` | nee | 22 | Dagelijks werk op de resources van één tenant. Geen identiteitsbeheer. |
| Tenant Read Only | `tenant_read_only` | nee | 17 | Ziet de resources van één tenant, wijzigt niets. |

De twee verschillen die mensen verrassen:

- **MSP Administrator verschilt van MSP Super Administrator door precies één recht:**
  `system.manage`. Al het overige — elke tenant, elke gebruiker, elke rol — is gelijk.
- **MSP Engineer kan het auditlog niet lezen.** Het landschap bedienen en nagaan wie wat heeft
  gedaan zijn gescheiden taken, en het auditlog is waar het handelen van de engineer zelf wordt
  vastgelegd.

---

## De volledige matrix

Elk recht tegen elke rol. Kolomkoppen, op volgorde: MSP Super Administrator, MSP Administrator, MSP
Engineer, MSP Read Only, Tenant Administrator, Tenant Operator, Tenant Read Only.

| Recht | Super | Admin | Eng | RO | T-Admin | T-Op | T-RO |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `tenants.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `tenants.manage` | ✓ | ✓ | · | · | · | · | · |
| `sites.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `sites.manage` | ✓ | ✓ | · | · | ✓ | · | · |
| `users.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `users.manage` | ✓ | ✓ | · | · | ✓ | · | · |
| `roles.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `roles.manage` | ✓ | ✓ | · | · | ✓ | · | · |
| `clusters.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `clusters.manage` | ✓ | ✓ | ✓ | · | ✓ | ✓ | · |
| `nodes.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `nodes.manage` | ✓ | ✓ | ✓ | · | ✓ | ✓ | · |
| `workloads.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `storage.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `networks.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `updates.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `updates.execute` | ✓ | ✓ | ✓ | · | ✓ | ✓ | · |
| `upgrades.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `upgrades.execute` | ✓ | ✓ | ✓ | · | ✓ | · | · |
| `automation.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `automation.manage` | ✓ | ✓ | ✓ | · | ✓ | · | · |
| `credentials.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `credentials.manage` | ✓ | ✓ | ✓ | · | ✓ | · | · |
| `credentials.rotate` | ✓ | ✓ | ✓ | · | ✓ | · | · |
| `migrations.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `migrations.execute` | ✓ | ✓ | ✓ | · | ✓ | · | · |
| `jobs.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `jobs.cancel` | ✓ | ✓ | ✓ | · | ✓ | ✓ | · |
| `jobs.approve` | ✓ | ✓ | · | · | ✓ | · | · |
| `alerts.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `alerts.manage` | ✓ | ✓ | ✓ | · | ✓ | ✓ | · |
| `reports.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `audit.read` | ✓ | ✓ | · | ✓ | ✓ | · | · |
| `system.manage` | ✓ | · | · | · | · | · | · |

Een test vergelijkt deze tabel bij elke run met de catalogus in de broncode. Wijken de twee af, dan
faalt de build in plaats van een referentie uit te leveren die stilletjes onwaar is.

---

## Wat elk recht toestaat

De fasekolom is eerlijk over welke rechten iets bewaken dat in deze build bestaat en welke
gereserveerd zijn voor de functie die ze straks nodig heeft. Een recht met een toekomstige fase is
vandaag toekenbaar en bewaakt nog niets.

| Recht | Staat toe | Actief vanaf |
|---|---|:-:|
| `tenants.read` | Klantorganisaties zien | 3 |
| `tenants.manage` | Klantorganisaties aanmaken, hernoemen en archiveren | 3 |
| `sites.read` | Fysieke of logische locaties binnen een tenant zien | 3 |
| `sites.manage` | Locaties aanmaken en wijzigen | 3 |
| `users.read` | Accounts, hun rollen en hun status voor meervoudige authenticatie zien | **2** |
| `users.manage` | Accounts aanmaken, in- en uitschakelen | **2** |
| `roles.read` | Rollen zien en wat ze toekennen | **2** |
| `roles.manage` | Rollen toekennen en intrekken | **2** |
| `clusters.read` | Proxmox-clusters en hun gezondheid zien | 4 |
| `clusters.manage` | Clusters toevoegen, configureren en verwijderen | 4 |
| `nodes.read` | Nodes, hun versies en hun toestand zien | 4 |
| `nodes.manage` | Nodes toevoegen, configureren en verwijderen | 4 |
| `workloads.read` | Virtuele machines en containers zien | 4 |
| `storage.read` | Opslagpools en hun gebruik zien | 4 |
| `networks.read` | Bridges, VLAN's en netwerkconfiguratie zien | 4 |
| `updates.read` | Beschikbare pakketupdates zien | 6 |
| `updates.execute` | Updates toepassen op echte nodes | 6 |
| `upgrades.read` | Plannen en gereedheid voor major upgrades zien | 8 |
| `upgrades.execute` | Een major upgrade uitvoeren tegen echte infrastructuur | 8 |
| `automation.read` | Schema's en automatiseringsregels zien | 8 |
| `automation.manage` | Schema's en automatiseringsregels aanmaken en wijzigen | 8 |
| `credentials.read` | Zien dát een credential bestaat, en de metadata ervan | 4 |
| `credentials.manage` | Credentials opslaan, vervangen en verwijderen | 4 |
| `credentials.rotate` | Een credential roteren op het doelsysteem | 10 |
| `migrations.read` | Migratieplannen en -analyses zien | 11 |
| `migrations.execute` | Een migratie uitvoeren | 11 |
| `jobs.read` | Wachtende, lopende en afgeronde jobs zien | 5 |
| `jobs.cancel` | Een lopende job annuleren | 5 |
| `jobs.approve` | Een job goedkeuren die op een mens wacht | 5 |
| `alerts.read` | Meldingen zien | 4 |
| `alerts.manage` | Meldingen bevestigen en afhandelen | 4 |
| `reports.read` | Rapporten zien en exporteren | 8 |
| `audit.read` | Het auditlog lezen | **2** |
| `system.manage` | Installatiebrede instellingen wijzigen, waaronder single sign-on | **2** |

**`credentials.read` leest geen geheim materiaal.** Het ziet dát een credential bestaat, waarvoor
het is en wanneer het voor het laatst is geroteerd. Geen enkel recht geeft toegang tot het geheim
zelf, omdat geen enkel eindpunt het teruggeeft — infrastructuurcredentials worden alleen binnen de
worker ontsleuteld, op het moment dat ze worden gebruikt. Zie
[Technische besluiten](tech-decisions.md), ADR-009 en ADR-023.

---

## Bevoorrechte rechten en meervoudige authenticatie

Deze veertien rechten laten een principal de infrastructuur van een klant of de beveiligingshouding
van de installatie wijzigen. Ze zijn waar het beleid `REQUIRED_FOR_PRIVILEGED` voor meervoudige
authenticatie op uitkomt:

`tenants.manage` · `sites.manage` · `users.manage` · `roles.manage` · `clusters.manage` ·
`nodes.manage` · `updates.execute` · `upgrades.execute` · `automation.manage` ·
`credentials.manage` · `credentials.rotate` · `migrations.execute` · `jobs.approve` ·
`system.manage`

Het is een expliciete lijst en niet "alles wat op `.manage` eindigt", want die twee zijn niet
hetzelfde. **`alerts.manage` ontbreekt bewust:** meldingen bevestigen en afhandelen verandert het
beeld dat Velnox zelf van de wereld heeft, niet de hypervisor van een klant. Een melding onderdrukken
kan een incident verbergen, wat het auditen waard is — maar niet het waard om er een tweede factor
voor af te dwingen.

Onder dit beleid vereisen vijf van de zeven rollen een tweede factor. Alleen **MSP Read Only** en
**Tenant Read Only** doen dat nooit, omdat ze niets anders dan `.read`-rechten hebben. Tenant
Operator vereist er wél een — die heeft `clusters.manage`, `nodes.manage` en `updates.execute`, en
die raken de hypervisor van een klant.

Het scherm Gebruikers noemt de bevoorrechte accounts zonder tweede factor, ongeacht welk beleid van
kracht is, zodat het risico zichtbaar is voordat je besluit het te sluiten.

---

## Wijzigen wat een rol toekent

Niet in deze build. De zeven systeemrollen worden aangemaakt en zijn alleen-lezen; er is geen scherm
om een rol aan te maken of te bewerken, en dat staat in [Bekende hiaten](known-gaps.md) in plaats van
dat het wordt gesuggereerd door het bestaan van een pagina die ze opsomt.

Het scherm **Rollen & rechten** leest uit je database en niet uit de catalogus, zodat het correct
blijft zodra bewerken er is. Toont het ooit een recht dat deze build niet kent, dan zegt het dat —
dat betekent dat de database en de code het oneens zijn, en dat is het zien waard in plaats van het
verbergen.

---

## Waar je hierna naartoe kunt

- [Gebruikers en toegang beheren](managing-access.md) — toekennen, intrekken en uitschakelen
- [Aan de slag](getting-started.md) — het eerste uur na de installatie
- [Technische besluiten](tech-decisions.md) — waarom de catalogus bevroren is, en wat dat kost
- [Architectuur](architecture.md) — waar de rechtencontrole daadwerkelijk plaatsvindt

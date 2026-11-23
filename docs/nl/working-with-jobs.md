# Jobs volgen, annuleren en goedkeuren

> **Vertaling.** Bron: [docs/working-with-jobs.md](../working-with-jobs.md) @ `66cc143`.
> **Engels is leidend.** Bij verschil tussen deze tekst en de Engelse versie geldt de Engelse tekst.

**Alles wat Velnox doet en langer duurt dan het laden van een pagina, is een job.** Een job heeft
een status, een lijst stappen, een geschiedenis van gebeurtenissen en de uitvoer van zijn stappen,
en alle vier blijven bewaard nadat hij klaar is. Deze handleiding gaat over het lezen daarvan en over
beslissen wat ermee gebeurt.

Wie wat mag, staat in [Rollen en rechten](permissions.md). Waarom het jobsysteem werkt zoals het werkt, staat
in ADR-035 en ADR-036 in [Technologiekeuzes](tech-decisions.md).

---

## Het scherm Jobs

**Jobs** in de zijbalk toont elke job die dit account mag zien, nieuwste eerst, met de status, hoe
ver hij is, wie hem startte en hoe lang hij duurde. Filter bovenaan de lijst op status. Een job die
over een cluster gaat, noemt het — in de lijst, in **Lopende jobs** en op de eigen pagina van de job,
die naar het cluster linkt.

De lijst leest zichzelf opnieuw in als er een job verandert, nooit vaker dan jouw verversinstelling
(je naam → **Instellingen → Schermen automatisch verversen**), en pauzeert zolang er een formulier op
openstaat. Staat verversen uit, dan doet hij geen van beide. Een job openen toont hem
**live**: gebeurtenissen komen binnen op het moment dat ze plaatsvinden, niet pas bij herladen.

**Lopende jobs**, onderin elke pagina, is dezelfde lijst beperkt tot wat er nu gebeurt: jobs die nog
niet klaar zijn, en die in het afgelopen half uur zijn afgerond, met hun status en voortgang, plus
uploads naar de ISO-bibliotheek. Klik erop om hem te openen of te sluiten; dat onthoudt hij in deze
browser.

### Oudere jobs uit beeld

De MSP Super Administrator kan afgeronde jobs na een aantal dagen verbergen voor iedereen zonder
`jobs.history`. Op het scherm **Jobs** vul je op de kaart **Oudere jobs** bovenaan het aantal dagen
in, van 1 tot 3650; laat het leeg, of kies **Weer elke job tonen**, om niets te verbergen. Dat is de
standaard.

- Een job telt vanaf het moment dat hij **klaar** was. Een job die nog in de wachtrij staat, loopt of
  op goedkeuring wacht, wordt nooit verborgen, hoe oud ook.
- **Er wordt niets verwijderd.** De job, zijn stappen en zijn uitvoer blijven in de database, voor de
  supportlogs van wie ze mag zien en voor iedereen met `jobs.history`.
- Een verborgen job is overal verborgen: in de lijst, in **Lopende jobs**, in de plaatsingsgeschiedenis
  van een cluster en in een export van de supportlogs. Zijn adres geeft 'niet gevonden', net als een
  job van een andere klant.
- Wie het treft, ziet boven de lijst een regel die zegt na hoeveel dagen jobs verborgen worden, zodat
  een lege lijst nooit lijkt alsof er niets gebeurd is.

`jobs.history` hoort bij de **MSP Super Administrator** en de **MSP Administrator**. Een eigen
MSP-rol kan het ook krijgen: in de rolbewerker staat het onder *Jobs*. Het aantal dagen instellen
vereist `system.manage`. Elke wijziging komt in het auditlog als `jobs.visibility_changed`, met de
oude en de nieuwe waarde.

## Wat de statussen betekenen

| Status | Betekenis |
|---|---|
| **In wachtrij** | Geaccepteerd, wacht tot een worker hem oppakt. |
| **Preflight** | Een worker heeft hem en controleert of hij kan starten. |
| **Actief** | Voert zijn stappen uit. |
| **Wacht op goedkeuring** | Geparkeerd bij een goedkeuringspunt tot iemand met het juiste recht beslist. |
| **Valideren** | Controleert het resultaat van wat hij deed. |
| **Geslaagd** | Afgerond, en elke stap is geslaagd. |
| **Deels geslaagd** | Afgerond, met sommige doelen gelukt en andere niet. |
| **Mislukt** | Niet afgerond. De job zegt waarom. |
| **Teruggedraaid** | Zijn wijzigingen zijn ongedaan gemaakt. |
| **Geannuleerd** | Op verzoek gestopt. |

De laatste vijf zijn definitief. Een job verandert nooit meer zodra hij er een bereikt.

---

## Een job volgen

De pagina van een job toont, van boven naar beneden: de status en voortgang, de reden waarom hij
stopte als hij mislukte, de goedkeuring die op een beslissing wacht als die er is, de stappen, de
gebeurtenissen, en de ruwe uitvoer van de stappen.

De uitvoer vult zich terwijl de job loopt: nieuwe regels worden elke twee seconden opgehaald, en het
venster volgt de nieuwste, tenzij je omhoog hebt gescrold om iets te lezen. Voor de gebeurtenissen
geldt hetzelfde. Een statuswijziging leest de pagina vanzelf opnieuw in, zodat de stappen en knoppen
altijd bij de getoonde status passen.

**Live** in de hoek betekent dat de stroom verbonden is. **Opnieuw verbinden…** betekent dat hij
wegviel en de browser hem terughaalt; er gaat niets verloren, want elke gebeurtenis heeft een
volgnummer en de browser vraagt om alles na het laatste nummer dat hij zag.

De lijst met gebeurtenissen verbergt voortgangsmeldingen standaard, omdat een lange stap om de paar
seconden voortgang meldt en al het andere ondersneeuwt. Vink **Voortgangsmeldingen tonen** aan om
ze te zien.

---

## Een job annuleren

**Job annuleren** vraagt de job om te stoppen. Wat daarna gebeurt, hangt af van waar hij is:

- **In wachtrij of wacht op goedkeuring** — er is nog niets uitgevoerd, dus hij wordt direct
  geannuleerd.
- **Actief** — hij stopt op het eerstvolgende veilige punt. Een stap die halverwege onderbroken kan
  worden (wachten, pollen, een overdracht) wordt onderbroken; een stap die dat niet mag — een
  pakketinstallatie, een herstart — mag eerst afronden. Velnox breekt nooit een wijziging af midden
  in een transactie.

Op de pagina van de job staat een stap die door de annulering werd onderbroken als **mislukt**, met
*Interrupted: the job was cancelled* erbij, en de stappen daarna als **overgeslagen**. De stap was
begonnen en niet afgemaakt, en "nooit uitgevoerd" zou onwaar zijn.

Een afgeronde job kan niet meer geannuleerd worden.

---

## Een job goedkeuren

Sommige jobs stoppen bij een **goedkeuringspunt** vóór een stap die iets wijzigt, en wachten. De
pagina van de job toont de reden, het recht dat nodig is, en de **wijzigingsset** — precies wat de
stap gaat doen. **Goedkeuren** laat hem vanaf het goedkeuringspunt verdergaan; **Afwijzen** laat hem
mislukken, en niets na het goedkeuringspunt wordt uitgevoerd. Voeg in beide gevallen een toelichting
toe als de volgende persoon wil weten waarom.

Om te beslissen heb je `jobs.approve` nodig voor de tenant van de job, **en** het recht dat het
goedkeuringspunt zelf noemt. Een upgradepunt vraagt om het recht om upgrades uit te voeren, niet
alleen om jobs goed te keuren.

### Vierogenprincipe

Een goedkeuringspunt kan een **ander** persoon vereisen dan wie de job startte. Dan kan wie hem
startte hem niet goedkeuren — het gaat erom dat niemand een eigen wijziging alleen
doordrukt — maar wel afwijzen, wat hetzelfde is als je eigen verzoek intrekken.

---

## Een job opnieuw proberen

**Opnieuw proberen** bij een mislukte, geannuleerde of teruggedraaide job start een **nieuwe** job met
dezelfde parameters. Het origineel blijft ongemoeid: de geschiedenis blijft precies zoals hij was, en
ze verwijzen naar elkaar (**Nieuwe poging voor** en **Opnieuw geprobeerd als**). Een geslaagde job kan
niet opnieuw worden geprobeerd.

---

## Eén job per cluster

Een job die een cluster wijzigt, houdt dat cluster vast zolang hij actief is — ook terwijl hij op
goedkeuring wacht, want een goedgekeurde wijzigingsset moet nog steeds het cluster beschrijven waarop
hij draait. Een tweede job op hetzelfde cluster starten wordt geweigerd, met de job die in de weg
staat erbij, en kan weer zodra de eerste klaar is.

De database dwingt dit af, niet alleen de applicatie, dus twee verzoeken die op hetzelfde moment
binnenkomen kunnen er niet allebei doorheen.

---

## Als de worker halverwege een job stopt

Als de worker wordt gestopt, crasht of opnieuw wordt uitgerold terwijl hij een job uitvoert, kan de
job niet afronden. Ongeveer een halve minuut later merkt Velnox dat op — de worker vernieuwt zijn
claim op de job niet meer — en zet de job op **mislukt** met *De worker is onverwacht gestopt*.

Hij wordt **niet** automatisch opnieuw gestart. Hij kan halverwege een wijziging zijn geweest, en hem
van voren af aan opnieuw draaien zou de eerste helft twee keer doen. Kijk bij welke stap hij was,
controleer de toestand van wat hij aan het wijzigen was, en probeer hem zelf opnieuw zodra dat
veilig is.

---

## De diagnostische job

**Diagnostische job** op het scherm Jobs (met `system.manage`) start een job die alleen tijd kost en
over zichzelf rapporteert. Hij raakt geen infrastructuur aan. Gebruik hem om het jobsysteem op jouw
installatie aan het werk te zien: stel een aantal stappen en een duur in, eventueel een stap om te
laten mislukken of een goedkeuringspunt om bij te stoppen, en kijk mee.

`scripts/verify-jobs.sh` gebruikt hetzelfde jobtype om al het bovenstaande tegen een draaiende
installatie te controleren, inclusief het halverwege stoppen van de worker. Draai het op een
testinstallatie, niet op een die echt werk doet.

---

## Rechten

| Om | Heb je nodig |
|---|---|
| Jobs te zien | `jobs.read` voor de tenant van de job |
| Een job te annuleren | `jobs.cancel` voor de tenant van de job |
| Goed te keuren of af te wijzen | `jobs.approve` voor de tenant van de job, plus het eigen recht van het goedkeuringspunt |
| Afgeronde jobs te zien die ouder zijn dan de ingestelde periode | `jobs.history` voor de tenant van de job |
| Die periode in te stellen | `system.manage` |
| Een job opnieuw te proberen | Wat het starten van dat soort job vereist — `system.manage` voor een diagnostische job |
| Een diagnostische job te starten | `system.manage` |

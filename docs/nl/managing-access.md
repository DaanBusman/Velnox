# Gebruikers en toegang beheren

> **Vertaling.** Bron: [docs/managing-access.md](../managing-access.md) @ `4321aad`.
> **Engels is leidend.** Bij verschil tussen deze tekst en de Engelse versie geldt de Engelse tekst.

**Alles over wie zich kan aanmelden bij Velnox en wat diegene mag.** Elk hoofdstuk is één taak,
geschreven om te lezen terwijl je hem uitvoert.

Voor wat elke rol toekent, zie [Rollen en rechten](permissions.md). Voor de overwegingen achter deze
keuzes in plaats van de stappen, zie [Technische besluiten](tech-decisions.md).

Elke taak hier vereist een eigen recht; de pagina noemt welk recht dat is wanneer je het mist, in
plaats van de knop te verbergen en je te laten raden.

---

## Een account aanmaken

**Je hebt nodig:** `users.manage` — MSP Super Administrator, MSP Administrator of Tenant
Administrator.

1. Ga naar **Gebruikers** onder Beheer.
2. Kies **Account toevoegen**.
3. Vul de naam, het e-mailadres en een beginwachtwoord van minimaal 12 tekens in.
4. Opslaan.

Velnox verstuurt geen e-mail, dus er is geen uitnodigingslink. Je stelt het beginwachtwoord zelf in
en geeft het zelf door, via het kanaal dat je voor elke andere credential zou gebruiken — niet via
dezelfde e-mail die het adres van de installatie bevat.

Het nieuwe account kan zich direct aanmelden en kan **niets**: een account zonder rollen is
geauthenticeerd maar niet geautoriseerd. Geef het hierna een rol.

> Deze build kent geen zelfbediening voor het wijzigen van een wachtwoord en geen reset door een
> beheerder. Dat staat vastgelegd in [Bekende hiaten](known-gaps.md) in plaats van dat je het moet
> ontdekken. Tot dat er is, is het wachtwoord van een account het wachtwoord waarmee het is
> aangemaakt.

---

## Iemand een rol geven

**Je hebt nodig:** `roles.manage`, dekkend voor wat de toekenning gaat dekken.

1. Ga naar **Gebruikers** en zoek het account op.
2. Kies een rol bij **Rol toekennen**.
3. Kies waarvoor die **geldt** — alle tenants, één tenant, of één locatie.
4. **Toekennen**. Het geldt vanaf het eerstvolgende verzoek van het account; er is verder niets toe
   te passen.

**De tweede keuze is de belangrijke.** Een rol zegt op zichzelf wat iemand mag doen; het bereik zegt
bij wie. "MSP Engineer" zegt niets nuttigs tot je weet of het één klant bereikt of allemaal, en
daarom staan de rollen van een account met hun bereik ernaast.

Er gelden drie regels, alle drie aan de serverzijde afgedwongen:

- **Je kunt niet toekennen wat je zelf niet hebt.** Een rol toekennen die een klant dekt vereist
  `roles.manage` dat diezelfde klant dekt — zo kan delegeren toegang nooit verbreden.
- **Het account van een klant blijft binnen de eigen tenant.** Alleen accounts in je eigen
  MSP-organisatie mogen een recht hebben dat naar de tenant van iemand anders wijst.
- **"Alle tenants" vereist een thuis in de MSP-organisatie**, en de optie wordt anders niet
  aangeboden.

Rollen met de aanduiding **alleen MSP** kunnen alleen worden toegekend aan accounts in je eigen
organisatie, niet aan medewerkers van een klant. Velnox dwingt ook dat aan de serverzijde af, dus het
geldt ongeacht wat de interface aanbiedt.

[Je omgeving indelen](organising-your-fleet.md) bevat een uitgewerkt voorbeeld van een engineer die
tot één locatie beperkt wordt.

[Rollen en rechten](permissions.md) beschrijft precies wat elke rol toekent. Lees dat voordat je er
voor het eerst een toekent: het verschil tussen MSP Engineer en MSP Administrator is niet
gebruikersbeheer, het is *het volledige* identiteitsbeheer, en dat blijkt niet uit de namen.

### Welke rol je geeft

- Iemand die het landschap beheert maar geen mensen hoort te beheren: **MSP Engineer**.
- Iemand die mensen én het landschap beheert maar niet de installatie zelf: **MSP Administrator**.
- Iemand die moet kunnen kijken en nooit aanraken — een auditor, een nieuwe collega in zijn eerste
  week: **MSP Read Only**.
- Houd **MSP Super Administrator** voor de accounts die installatiebrede instellingen echt nodig
  hebben. Het is de enige rol met `system.manage`.

---

## Een rol intrekken

**Je hebt nodig:** `roles.manage`.

Gebruik **Intrekken** naast de rol op het account.

Bij de oprichtend beheerder ontbreekt die knop, omdat het antwoord nee zou zijn. Zie
[De oprichtend beheerder](#de-oprichtend-beheerder) hieronder.

Een rol intrekken meldt het account niet af. Het verandert wat het eerstvolgende verzoek mag doen, en
dat is wat telt; een sessie zonder rechten kan de afmeldknop bereiken en verder niets.

---

## Een account uitschakelen of weer inschakelen

**Je hebt nodig:** `users.manage`.

Gebruik **Uitschakelen** op het account. Dat trekt onmiddellijk de sessies in en weigert verdere
aanmeldingen. **Inschakelen** zet het precies terug zoals het was, rollen inbegrepen.

Schakel uit in plaats van te verwijderen wanneer iemand vertrekt. Een account verwijderen zou de
audithistorie ervan verweesd achterlaten, en het auditlog is juist append-only zodat die historie
blijft bestaan; een uitgeschakeld account houdt het verslag van wat het heeft gedaan intact en
toewijsbaar.

---

## De oprichtend beheerder

Het account dat de installatiewizard aanmaakt is gemarkeerd als oprichtend beheerder, en Velnox
behandelt het op precies twee punten anders:

- **De rollen ervan kunnen niet worden ingetrokken.** Niet door een andere beheerder, en niet door
  het account zelf.
- **Het kan niet worden uitgeschakeld zolang geen ander ingeschakeld account deze installatie kan
  beheren.** Zodra er een tweede beheerder is, mag uitschakelen wel.

Uitschakelen blijft mogelijk omdat het omkeerbaar is voor iedereen die nog rechten heeft, en een
organisatie moet een vertrokken beheerder kunnen stoppen. De rechten afnemen is van binnenuit het
product *niet* omkeerbaar, en daar zit het hele verschil.

De interface vermeldt dit bij het account, in plaats van je een ontbrekende knop te laten ontdekken.

**Wat dit voor jou betekent:** één account is blijvend bevoorrecht. Geef het een sterk wachtwoord,
zet er meervoudige authenticatie op, en maak vroeg een tweede beheerder aan zodat het oprichtend
account niet de enige weg naar binnen is — een account waarvan het wachtwoord in het hoofd van één
persoon zit is een single point of failure, wat de software ook toestaat.

---

## Meervoudige authenticatie aanzetten voor jezelf

**Je hebt nodig:** een account. Dit is persoonlijk en vereist geen recht.

1. Ga naar **Beveiliging** onder Beheer.
2. Kies **Meervoudige authenticatie instellen**.
3. Scan de QR-code met een authenticator-app, of typ het getoonde geheim met de hand over.
4. Voer één code uit de app in.
5. Bewaar de tien herstelcodes.

Er wordt niets aangezet voordat stap 4 slaagt. Die volgorde is bewust: een instelling die actief zou
worden voordat ze bewezen is, sluit je buiten je eigen account met een geheim dat je app nooit heeft
opgeslagen.

**De herstelcodes worden eenmalig getoond.** Ze worden op dezelfde manier gehasht als wachtwoorden,
dus Velnox kan ze niet nog eens tonen — het heeft ze niet. Bewaar ze ergens die niet de machine is
waarop Velnox draait en niet de telefoon met de authenticator. Raak je ze kwijt, dan kun je op
dezelfde pagina een nieuwe set genereren zolang je nog bent aangemeld; de oude set werkt niet meer
vanaf het moment dat de nieuwe is gemaakt.

---

## Aanmelden als je je authenticator kwijt bent

Kies bij de vraag om de tweede factor voor **Herstelcode gebruiken** en voer een van de bewaarde
codes in.

Elke code werkt precies één keer. Het gebruik wordt naar het auditlog geschreven, want een gebruikte
herstelcode is óf een collega met een pechdag óf een aanvaller met een goede dag, en die twee zien er
op dat moment identiek uit.

Ga daarna naar **Beveiliging**, zet meervoudige authenticatie uit, en stel hem opnieuw in met het
nieuwe apparaat. Genereer meteen een nieuwe set herstelcodes.

> Gebruik van een herstelcode wordt gelogd maar nog nergens buiten het auditlog gemeld. Dat staat in
> [Bekende hiaten](known-gaps.md). Tot dat er is, is het auditlog de plek om te kijken.

---

## De meervoudige authenticatie van iemand anders resetten

**Je hebt nodig:** `users.reset_mfa`, en voor een account in je eigen organisatie ook
`users.reset_mfa_msp`. Zie [wie wie mag resetten](#wie-wie-mag-resetten) hieronder.

Voor de collega of klant die zowel de authenticator als de herstelcodes kwijt is.

1. Ga naar **Gebruikers** en zoek het account op.
2. Kies **Tweede factor resetten**.
3. Bevestig. Laat het diegene buiten Velnox om weten.

De instelling van het account wordt verwijderd, de ongebruikte herstelcodes worden gewist, en de
sessies worden ingetrokken. Bij de eerstvolgende aanmelding kan het account opnieuw instellen. Aan
het wachtwoord en de rollen verandert niets.

De handeling wordt onder een eigen actie naar het auditlog geschreven, apart van iemand die zijn
eigen tweede factor uitzet, zodat een auditor de twee kan onderscheiden zonder te moeten afleiden.

### Wie wie mag resetten

| Jij bent | Account van een klant | Account in je eigen organisatie | Je eigen account |
|---|:-:|:-:|:-:|
| MSP Super Administrator | ja | ja | **nee** |
| MSP Administrator | ja | nee | **nee** |
| MSP Engineer | ja | nee | **nee** |
| Alle anderen | nee | nee | **nee** |

**Niemand kan zijn eigen tweede factor resetten.** Een Super Administrator niet, de oprichtend
beheerder niet. Gebruik daarvoor **Beveiliging**, waar om een code uit je authenticator wordt
gevraagd — die vraag bewijst dat je de factor nog hebt, en dat is precies waarom zelfbediening
veilig is. Een beheerder die zijn eigen tweede factor kon wissen, zou elke bevoorrechte tweede
factor verwijderbaar maken met het bijbehorende wachtwoord, en dat komt neer op er geen hebben.

Ben jij dus degene die het apparaat kwijt is, dan moet een ander het voor je doen. Op een
installatie met één beheerder is die ander er niet, wat nog een reden is om vroeg een tweede
beheerder aan te maken — zie [De oprichtend beheerder](#de-oprichtend-beheerder).

**Waarom een engineer het wel voor een klant mag en niet voor een collega.** Een account in je eigen
organisatie kan bij elke klant die je beheert. De tweede factor daarvan verwijderen is een grotere
handeling dan bij een klant, en vereist daarom een recht dat alleen de Super Administrator heeft.
Velnox dwingt dat aan de serverzijde af, niet door de knop te verbergen.

---

## Meervoudige authenticatie verplichten

Velnox dwingt drie beleidsvormen af:

| Beleid | Effect |
|---|---|
| `OPTIONAL` | Iedereen mag hem instellen; niemand hoeft. De standaard. |
| `REQUIRED_FOR_PRIVILEGED` | Accounts met een bevoorrecht recht moeten hem instellen voordat ze iets anders kunnen. |
| `REQUIRED` | Elk account moet hem instellen. |

Een sessie die niet aan een verplicht beleid voldoet, kan precies twee dingen bereiken: het instellen
zelf, en afmelden. Elk ander eindpunt weigert haar. Dat is getoetst tegen *elk* eindpunt in de build
in plaats van tegen een steekproef, zodat een later toegevoegd eindpunt niet stilletjes aan de regel
kan ontsnappen.

[Rollen en rechten](permissions.md) noemt welke rechten als bevoorrecht gelden.

> **Deze build heeft geen scherm om het beleid te wijzigen.** De handhaving is compleet en getest;
> de instelling is een databasekolom die standaard op `OPTIONAL` staat, en het instellingenscherm dat
> hem schrijft komt met de rest van de installatie-instellingen. Dat zeggen is nuttiger dan een knop
> beschrijven die er niet is. Ondertussen noemt de pagina Gebruikers de bevoorrechte accounts zonder
> tweede factor, zodat het risico zichtbaar is ook al kun je het beleid nog niet afdwingen.

---

## Microsoft Entra ID koppelen

**Je hebt nodig:** `system.manage`, en in Entra de rol Application Administrator, Cloud Application
Administrator of Global Administrator.

Ga naar **Single sign-on** onder Beheer. Het is een wizard van zes stappen, omdat het koppelen van
een directory betekent dat je een paar keer tussen twee browsertabbladen wisselt en de volgorde
ertoe doet.

| Stap | Wat er gebeurt |
|---|---|
| 1. Voordat je begint | Wat je nodig hebt. Lees het — Entra toont een clientsecret maar één keer. |
| 2. App-registratie | Velnox toont de exacte naam en redirect-URI die je moet gebruiken. |
| 3. Identificaties | Plak de directory- (tenant-) ID en de application- (client-) ID terug. |
| 4. Clientsecret | Plak de **waarde** van het secret, niet de secret-ID. |
| 5. Wie mag aanmelden | Optioneel beperken welke e-maildomeinen mogen authenticeren. |
| 6. Opslaan en controleren | Velnox slaat het op en haalt het discovery-document van de provider op. |

Twee details veroorzaken de meeste mislukte pogingen:

- **De redirect-URI moet exact overeenkomen.** Velnox leidt hem af uit het eigen adres van de
  installatie en toont hem met een kopieerknop; een afsluitende schuine streep is voor Entra een
  andere URI.
- **De waarde van het secret wordt eenmalig getoond.** Navigeer je weg voordat je hem hebt
  gekopieerd, verwijder dan dat secret in Entra en maak een nieuwe aan. Hij is niet terug te lezen.

Het clientsecret wordt versleuteld voordat het wordt opgeslagen, wordt door geen enkele API-response
teruggegeven, en verschijnt niet in een log of een auditrecord. De pagina toont alleen óf er een
secret aanwezig is.

Stap 6 is een echte verbindingspoging naar de provider, geen "opgeslagen"-melding. Je komt er nu
achter dat de configuratie fout is, en niet bij iemands eerste aanmelding.

> **Aanmelden met Entra werkt nog niet.** De configuratie, de discoveryvalidatie en de
> verbindingstest zijn compleet; de callback die een Microsoft-identiteit in een Velnox-sessie
> omzet, is dat niet. De aanmeldpagina biedt de knop niet aan, dus niets hiervan kan je laten
> stranden — maar zet lokale wachtwoorden niet buiten gebruik op grond van een geslaagde
> verbindingstest. Zie [Bekende hiaten](known-gaps.md).

---

## Het auditlog lezen

**Je hebt nodig:** `audit.read` — Super Administrator, Administrator, MSP Read Only of Tenant
Administrator.

Open **Serverbeheer** onderaan de zijbalk en kies **Auditlog**. Gebeurtenissen staan nieuwste eerst,
zijn te filteren op actie, en oudere pagina's worden aangevuld in plaats van dat ze vervangen wat je
aan het lezen bent.

Heb je `audit.read` maar geen `system.manage` — MSP Read Only, of een Tenant Administrator — dan is
er voor jou geen Serverbeheer-venster, en blijft **Auditlog** onder Beheer in de zijbalk staan.
Zelfde paneel, zelfde gegevens; alleen de weg ernaartoe verschilt.

Elke authenticatie- en autorisatiegebeurtenis wordt vastgelegd: aanmeldingen en mislukte pogingen,
afmeldingen, geweigerde rechten, toekenningen en intrekkingen van rollen, statuswijzigingen van
accounts, het instellen van meervoudige authenticatie, gebruik van herstelcodes, en wijzigingen aan
de identityprovider.

De tabel is **append-only**, afgedwongen door een databasetrigger die `UPDATE` en `DELETE` weigert —
ook vanuit Velnox zelf. Een gebeurtenis kan achteraf niet worden gewijzigd of verwijderd door iemand
die geen superuseraccount op de database van de machine heeft gekregen, en dat is iets anders en veel
groters om te bezitten.

Auditrecords bevatten nooit een wachtwoord, een token, een secret of een herstelcode. Veldnamen die
op een credential lijken worden geredigeerd voordat er iets wordt weggeschreven, en er is een test
die vastlegt welke namen overleven, omdat die bescherming eerder stilletjes is teruggevallen.

---

## Wat waar wordt afgedwongen

Nuttig om te weten wanneer iets wordt geweigerd en je probeert te achterhalen waarom.

- **De API beslist.** Elke rechtencontrole gebeurt aan de serverzijde. De interface verbergt knoppen
  die je niet kunt gebruiken uit hoffelijkheid, niet als beveiliging — een verzoek dat op een andere
  manier wordt gedaan, wordt net zo geweigerd.
- **Toekenningen dragen een bereik.** Een toekenning dekt haar bereik en alles daaronder: globaal,
  dan tenant, dan locatie, dan cluster. Globaal bereik is alleen toekenbaar aan leden van je eigen
  organisatie. De bereiken onder globaal worden bruikbaar in fase 3, wanneer er meer dan één tenant
  is.
- **Een weigering wordt geaudit.** Een 403 is een vastgelegde gebeurtenis, geen stil nee.

---

## Waar je hierna naartoe kunt

- [Rollen en rechten](permissions.md) — de volledige matrix van wat elke rol toekent
- [Je omgeving indelen](organising-your-fleet.md) — tenants, locaties en het beperken van een recht
- [Aan de slag](getting-started.md) — het eerste uur na de installatie
- [Bekende hiaten](known-gaps.md) — wat er op dit moment bewust ontbreekt
- [Technische besluiten](tech-decisions.md) — waarom deze keuzes, en wat ze kosten

# Je omgeving indelen: tenants en locaties

> **Vertaling.** Bron: [docs/organising-your-fleet.md](../organising-your-fleet.md) @ `4321aad`.
> **Engels is leidend.** Bij verschil tussen deze tekst en de Engelse versie geldt de Engelse tekst.

**Alles over het opdelen van de installatie per klant en per locatie.** Elk hoofdstuk is één taak,
geschreven om te lezen terwijl je hem uitvoert.

Voor accounts, rollen en aanmelden, zie [Gebruikers en toegang beheren](managing-access.md). Voor wat
elke rol precies toekent, zie [Rollen en rechten](permissions.md).

---

## Wat een tenant is

Een **tenant** is één klantorganisatie. Elk account, elke locatie, elke credential en — vanaf fase 4
— elk cluster hoort bij precies één tenant.

Er is altijd één bijzondere tenant: **je eigen MSP-organisatie**, aangemaakt door de installatie­
wizard. Die is overal gemarkeerd met `MSP`. Accounts daarin zijn de accounts die over klanten heen
kunnen kijken; accounts in de tenant van een klant zien alleen die klant.

Die grens is geen filter op een scherm. Hij wordt in de datalaag toegepast, onder elke bevraging die
de software doet, en een verzoek dat binnenkomt zonder vastgesteld tenantbereik wordt geweigerd in
plaats van beantwoord met alles. In de praktijk betekent dat: je kunt je niet *per abuis* zo
instellen dat de ene klant de infrastructuur van een andere ziet — die instelling bestaat niet in de
interface, en ook niet in de API.

**Een tenant is geen map.** Dingen tussen tenants verplaatsen kan bewust niet. Een locatie hoort bij
de tenant waarin hij is aangemaakt, zijn hele leven lang, omdat verplaatsen elk recht dat eraan hangt
stilletjes mee zou verhuizen.

---

## Een klant-tenant aanmaken

Je hebt `tenants.manage` **op globaal bereik** nodig — in de praktijk MSP Super Administrator of MSP
Administrator. Een recht dat één klant dekt geeft je niet de mogelijkheid een andere aan te maken, en
de weigering zegt dat ook.

1. Ga naar **Tenants**.
2. **Tenant toevoegen**.
3. Geef de naam van de klant zoals je die op een factuur zou schrijven. De korte aanduiding die in
   URLs verschijnt wordt daar automatisch van afgeleid; hebben twee klanten dezelfde naam, dan krijgt
   de tweede er een nummer achter in plaats van een weigering.
4. **Tenant toevoegen**.

De tenant verschijnt meteen, zonder accounts en zonder locaties. Niemand kan zich erbij aanmelden tot
je er een account aanmaakt — zie *Een account toevoegen* in
[Gebruikers en toegang beheren](managing-access.md), waar je nu de tenant kunt kiezen.

### Meervoudige authenticatie verplichten voor één klant

Elke tenant heeft een eigen beleid voor de tweede factor, en het geldende beleid voor een account is
**het strengste van dat van de installatie en dat van de tenant**. Een klant wiens contract dat eist
kan op `Verplicht voor iedereen` gezet worden zonder dat er voor iemand anders iets verandert, en het
installatiebrede beleid kan door een tenant nooit versoepeld worden.

Open **Details** van de tenant en wijzig **Tweede factor**.

---

## Een locatie toevoegen

Een **locatie** is een plek binnen een tenant: een datacenter, een kantoor, een rack in een colocatie.
Twee dingen hebben ze nodig:

- een recht kan tot één locatie beperkt worden in plaats van tot de hele klant;
- vanaf fase 4 hoort een cluster bij een locatie, en dat is wat "alles in Amsterdam" tot een vraag
  maakt die de software kan beantwoorden.

Je hebt `sites.manage` nodig, dekkend voor die tenant.

1. Ga naar **Locaties**.
2. **Locatie toevoegen**.
3. Kies de **tenant**. Dat kan alleen nu: zodra de locatie bestaat, ligt dat vast.
4. Geef hem een naam, en leg desgewenst vast waar hij staat en wie je erover belt. De contactpersoon
   is een notitie voor wie dit tijdens een storing leest — Velnox verstuurt geen e-mail en gebruikt
   hem nergens voor.
5. **Locatie toevoegen**.

### Verwijderen

Een locatie kan verwijderd worden zodra er niets meer naar wijst. Is er nog een recht tot die locatie
beperkt, dan wordt het verwijderen geweigerd en toont het scherm om hoeveel het gaat — trek die eerst
in. De reden is het weten waard: het bereik van een recht wordt als kale aanduiding opgeslagen, dus
een verwijderde locatie zou rechten achterlaten die toegekend lijken en niets dekken. Een recht dat
stilletjes betekenisloos is geworden is erger dan een recht dat nooit gegeven is, want niemand gaat
ernaar zoeken.

Een locatie verwijderen verbergt hem. Wat er in het auditlogboek over vastligt blijft leesbaar.

---

## Een recht beperken tot minder dan "alles"

Dit is het deel dat je manier van werken verandert zodra je meer dan één klant hebt.

Een toekenning bestaat uit twee helften: **welke rol**, en **waarvoor die geldt**. Vóór fase 3 was er
op de tweede maar één antwoord — alles — wat eerlijk was bij één tenant en onjuist bij vijftig.

De bereiken, van breed naar smal:

| Bereik | Dekt | Wie het mag hebben |
|---|---|---|
| **Alle tenants** | De hele installatie | Alleen accounts in de MSP-organisatie |
| **Tenant** | Eén klant, en elke locatie en elk cluster daaronder | Iedereen |
| **Locatie** | Eén locatie, en elk cluster daarin | Iedereen |

Zo ken je er een toe:

1. Ga naar **Gebruikers** en klap de rij van het account open.
2. Kies onder **Rol toekennen** de rol, en kies daarna **Geldt voor**.
3. **Toekennen**.

De rollen van het account staan daarna met hun bereik ernaast, omdat "MSP Engineer" op zichzelf niets
nuttigs zegt zodra een recht smaller kan zijn dan alles — de interessante helft is welke klant het
bereikt.

### Wat je wel en niet kunt toekennen

- **Je kunt niet toekennen wat je zelf niet hebt.** Een rol toekennen die een klant dekt vereist
  `roles.manage` dat diezelfde klant dekt. Deze regel voorkomt dat delegeren een manier wordt om
  toegang te verbreden: een beheerder die één klant heeft gekregen kan die klant uitdelen en verder
  niets.
- **Het account van een klant blijft binnen de eigen tenant.** Iemand bij Contoso een bereik bij
  Northwind geven wordt geweigerd. Alleen accounts in de MSP-organisatie mogen een recht hebben dat
  naar de tenant van iemand anders wijst — dat is wat het beheren van andermans infrastructuur ís.
- **"Alle tenants" vereist een thuis in de MSP-organisatie.** De database weigert het voor ieder
  ander, en de optie wordt niet aangeboden.

### Een uitgewerkt voorbeeld

Je hebt een engineer aangenomen die het Amsterdamse datacenter van één klant beheert en verder niets.

1. Maak zijn account aan in **je eigen MSP-organisatie** — het is jouw medewerker, niet die van de
   klant.
2. Ken **MSP Engineer** toe, geldend voor **Locatie: Amsterdam (Contoso Cloud)**.

Hij kan die locatie nu zien en eraan werken. De overige locaties van Contoso, en elke andere klant,
zijn niet alleen verborgen — de API weigert het verzoek, en de datalaag zou het er nog uitfilteren
ook als dat niet zo was.

---

## Een klant opschorten of archiveren

**Opschorten** is een pauze. **Archiveren** is hoe een klant uit beeld verdwijnt.

Geen van beide verwijdert iets. Velnox kan de geschiedenis van een klant niet vanuit de interface
wissen, en dat is met opzet: een auditspoor met een gat erin is erger dan geen auditspoor, en "wij
werken niet meer met deze klant" is een andere uitspraak dan "wis wat er gebeurd is".

Archiveren:

1. Schakel eerst elk account in de tenant uit. Archiveren wordt geweigerd zolang er nog iemand kan
   aanmelden — een gearchiveerde klant wiens mensen nog toegang hebben is het slechtste van beide, en
   het scherm zegt om hoeveel accounts het gaat.
2. Open **Details** van de tenant en kies **Tenant archiveren**.

Twee tenants kunnen nooit gearchiveerd worden: **je eigen MSP-organisatie**, want daarmee zouden de
accounts die deze installatie beheren uitgeschakeld worden, het jouwe inbegrepen, en **de tenant waar
je eigen account onder valt**.

---

## Filteren wat je bekijkt

Met **Tenant** in de bovenbalk beperk je Locaties en Gebruikers tot één klant. Kies je je eigen
MSP-organisatie, dan zie je alleen je eigen collega's.

Het is een filter en niets meer. Het kan je niets tonen wat je account niet toch al kon bereiken —
het bereik wordt eronder toegepast, en een tenant kiezen waar je geen toegang toe hebt levert
eenvoudigweg niets op. De keuze reist met je mee tussen pagina's en verschijnt helemaal niet als je
account precies één tenant bereikt, want dan zou het een knop zijn die op een keuze lijkt en er geen
is.

---

## Waar je hierna naartoe kunt

- [Gebruikers en toegang beheren](managing-access.md) — accounts, rollen, tweede factor, Entra ID SSO
- [Rollen en rechten](permissions.md) — wat elke rol volledig toekent
- [Aan de slag](getting-started.md) — het eerste uur na de installatie

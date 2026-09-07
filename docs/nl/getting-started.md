# Aan de slag met Velnox

> **Vertaling.** Bron: [docs/getting-started.md](../getting-started.md) @ `6f0fd09`.
> **Engels is leidend.** Bij verschil tussen deze tekst en de Engelse versie geldt de Engelse tekst.

**Deze handleiding is voor wie Velnox zojuist heeft geïnstalleerd en naar een leeg scherm kijkt.**
Hij behandelt het eerste uur: het eerste account aanmaken, de weg vinden, controleren of de
installatie echt gezond is, en weten wat er nog niet is.

Voor de serververeisten, het installatiecommando zelf en het upgradepad, zie
[Deployment](deployment.md). Voor alles over accounts, rollen en aanmelden, zie
[Gebruikers en toegang beheren](managing-access.md).

---

## Wat je nodig hebt voordat je begint

- Een machine met Debian 12/13 of Ubuntu 22.04/24.04, 4 vCPU / 8 GB RAM / 60 GB schijf, bereikbaar
  op poort 80 en 443. [Deployment](deployment.md) bevat de volledige vereisten en de
  hypervisorinstellingen die ertoe doen.
- Het adres dat beheerders gaan intypen. Een DNS-naam is beter dan een IP-adres: een IP kan geen
  publiek vertrouwd certificaat dragen, en het adres is nu juist het onderdeel dat je later het
  moeilijkst nog kunt wijzigen.
- Een wachtwoordmanager die je daadwerkelijk gebruikt. Het installatieprogramma toont aan het einde
  een `MASTER_ENCRYPTION_KEY`, en er is geen herstelpad als die verloren gaat.

Velnox heeft geen internettoegang nodig om te draaien. Alleen eenmalig tijdens de installatie, om de
containerimages op te halen.

---

## Installeren

Op de doelmachine, als gebruiker met `sudo`:

```bash
sudo apt-get update && sudo apt-get install -y git && sudo git clone https://github.com/DaanBusman/Velnox.git /opt/velnox && sudo bash /opt/velnox/install.sh
```

Het installatieprogramma stelt twee vragen — het adres, en of je een zelfondertekend of een publiek
vertrouwd certificaat wilt — en bouwt en start daarna alles. Vijf tot tien minuten, grotendeels
opgaand aan het bouwen van images.

Als het klaar is toont het de URL, de `MASTER_ENCRYPTION_KEY`, en het resultaat van een verificatie
tegen de zojuist gemaakte installatie. **Lees dat verificatieresultaat.** Het is het verschil tussen
"het installatieprogramma eindigde met 0" en "de software werkt", en dat zijn niet dezelfde
bewering.

Bij een zelfondertekend certificaat waarschuwt je browser eenmalig wanneer je het adres voor het
eerst opent. Dat hoort zo en is geen teken dat er iets misging: het certificaat is uitgegeven door
de eigen certificaatautoriteit van de installatie, waar je browser nog nooit van heeft gehoord.

---

## De eerste beheerder aanmaken

Open het adres. Omdat nog niemand zich heeft aangemeld toont Velnox de installatiewizard in plaats
van een aanmeldscherm.

Er bestaan nergens in Velnox standaardinloggegevens, dus er is achteraf niets te wijzigen en niets
om te vergeten te wijzigen. De wizard is op een verse installatie de enige manier waarop een account
ontstaat, en hij sluit definitief zodra hij is uitgevoerd.

Er wordt gevraagd om:

| Veld | Waar het voor dient |
|---|---|
| Organisatienaam | Je eigen MSP. Het benoemt de hoofdtenant en verschijnt in de interface. |
| Je naam | Getoond bij auditgebeurtenissen, zodat "wie heeft dit gedaan" een persoon is en geen e-mailadres. |
| E-mailadres | Je aanmeldnaam. Velnox verstuurt geen e-mail; dit is een identificatie. |
| Wachtwoord | Minimaal 12 tekens. Dezelfde regel geldt daarna voor elk account. |

Verzenden maakt in één databasetransactie aan: de MSP-hoofdtenant, de systeemrollen, en jouw account
met **MSP Super Administrator** op globaal bereik. Mislukt een onderdeel, dan is er niets gebeurd —
je kunt niet met een half geïnitialiseerde installatie eindigen.

Een tweede poging tot de wizard levert een foutmelding op in plaats van nog een beheerder.

### Jouw account is blijvend bijzonder

Het account dat de wizard aanmaakt is de **oprichtend beheerder**. De rollen ervan kunnen door
niemand worden ingetrokken, ook niet door het account zelf, en het kan niet worden uitgeschakeld
zolang geen ander ingeschakeld account de installatie kan beheren.

Dit bestaat omdat het alternatief zich heeft voorgedaan. Een beheerder kon zijn eigen laatste rol
intrekken, en op een installatie met één account — wat elke installatie op haar eerste dag is —
haalde dat het laatste recht uit het systeem. Aanmelden werkte nog. Niets was toegestaan. De enige
weg terug was een databaseprompt, in een product waarvan het hele uitgangspunt is dat beheerders die
niet nodig zouden moeten hebben.

De prijs is echt en het is eerlijk hem te noemen: één account in je installatie is blijvend
bevoorrecht, dus het wachtwoord en de tweede factor ervan wegen zwaarder dan die van elk ander
account. Geef het een sterk wachtwoord en zet er meervoudige authenticatie op voordat je iets anders
doet.

---

## Meervoudige authenticatie instellen

Doe dit nu en niet later, terwijl er precies één account is en je een collega niet kunt buitensluiten
door te experimenteren.

Ga naar **Beveiliging** onder Beheer. Bij het instellen verschijnt een QR-code, wordt om één code
uit je authenticator-app gevraagd om te bewijzen dat het werkt voordat er iets wordt aangezet, en
worden daarna tien eenmalig bruikbare herstelcodes getoond.

De herstelcodes worden **eenmalig** getoond. Bewaar ze ergens die niet de machine is waarop Velnox
draait en niet de telefoon met de authenticator — anders raak je met één apparaat beide helften
kwijt. [Gebruikers en toegang beheren](managing-access.md) beschrijft wat je doet als iemand zijn
authenticator tóch kwijtraakt.

---

## De weg vinden

De zijbalk toont de vorm van het voltooide product, niet die van deze build. Onderdelen die een
latere fase implementeert staan er wel en leiden naar een pagina die de fase noemt, in plaats van
verborgen te zijn — verbergen zou verkeerd weergeven waar Velnox voor is, en ze vullen met
voorbeeldgegevens zou de werkelijkheid verkeerd weergeven.

Werkt vandaag:

| Waar | Wat het doet |
|---|---|
| **Dashboard** | Toestand van de installatie, en suggesties voor wat nu de moeite waard is |
| **Gebruikers** | Accounts, rollen, in- en uitschakelen — zie [Gebruikers en toegang beheren](managing-access.md) |
| **Rollen & rechten** | Wat elke rol toekent — zie [Rollen en rechten](permissions.md) |
| **Auditlog** | Elke authenticatie- en autorisatiegebeurtenis, nieuwste eerst |
| **Beveiliging** | Meervoudige authenticatie voor je eigen account |
| **Single sign-on** | De wizard voor Microsoft Entra ID |
| **Instellingen → Over** | Versie, buildcommit, licentie en het bronaanbod |
| **Documentatie** | Deze documentatie, offline, gestempeld met de draaiende versie |

Wacht op een latere fase: tenants en locaties (fase 3); clusters, nodes, virtuele machines,
containers, opslag en netwerken (fase 4); jobs (fase 5); updates (fase 6); major upgrades (fase 8);
migraties (fase 11). [Roadmap](roadmap.md) bevat de volledige volgorde en wat elke fase oplevert.

---

## Taal of thema wijzigen

Beide staan in de bovenbalk, en beide zijn per persoon in plaats van per installatie: de keuze van
je collega verandert die van jou niet.

Velnox wordt geleverd in het Engels en het Nederlands. Elke zichtbare tekst komt uit een
vertaalcatalogus — er zitten geen Engelse zinnen in de code verstopt die opeens midden op een
Nederlandse pagina opduiken — en de API geeft foutcodes terug in plaats van zinnen, zodat een
melding in de taal van de lezer wordt weergegeven en niet in die van de server.
[Lokalisatiearchitectuur](i18n.md) legt uit hoe dat wordt afgedwongen.

De installatiebrede standaarden voor nieuwe accounts zijn `VELNOX_DEFAULT_LOCALE` en
`VELNOX_DEFAULT_TIMEZONE` in `.env`.

---

## Controleren of de installatie gezond is

Drie niveaus van antwoord, in oplopende grondigheid.

**Vanuit de interface:** het Dashboard toont de toestand van elke afhankelijkheid.

**Van overal:** `https://<jouw-adres>/readyz` geeft de status van de database, Redis, de wachtrij en
de migratiestand als JSON. Dat eindpunt is bewust niet geauthenticeerd, zodat een externe monitor het
kan bevragen zonder een credential te bezitten; het bevat geen secrets en geen configuratie.

**Vanaf de machine, grondig:**

```bash
cd /opt/velnox && bash scripts/verify-stack.sh https://velnox.example.internal
```

Dat is dezelfde verificatie die het installatieprogramma uitvoert: vijfendertig controles op TLS, de
beveiligingsheaders, de API, de worker, de wachtrij, de databasemigraties, de lokalisatie, en de
overeenstemming tussen de versie van de draaiende build en die van zijn documentatie. Voer hem uit na
elke wijziging aan de machine.

Gaat er iets mis, dan bevat [Deployment](deployment.md) het diagnosehoofdstuk, en zijn de
containerlogs de volgende plek om te kijken:

```bash
cd /opt/velnox && sudo docker compose -f deploy/compose/docker-compose.yml --env-file .env logs -f api
```

---

## Deze documentatie offline lezen

Velnox wordt geïnstalleerd op beheernetwerken die het internet vaak niet kunnen bereiken, en het
moment waarop je documentatie het hardst nodig hebt is het moment waarop er iets stuk is — een slecht
moment om te ontdekken dat ze op GitHub staat. Daarom zit ze in de build, onder **Documentatie**.

Elke pagina vermeldt de versie waaruit ze is gebouwd. Die tekst komt uit dezelfde bron als de versie
die de draaiende software rapporteert, voortgebracht door dezelfde build, dus de documentatie en de
software kunnen geen release uit elkaar lopen. Toont een pagina ooit een andere versie dan
**Instellingen → Over**, dan zegt de pagina dat, in plaats van je instructies voor een andere release
te laten lezen.

---

## Wat er nog niet is

Hier direct over zijn is nuttiger dan een functielijst.

Velnox kan nog niet met Proxmox praten. Er is in deze build geen cluster, geen node, geen virtuele
machine en geen job die echte infrastructuur raakt — dat begint in fase 4, en de handleidingen voor
**een cluster aanmaken** en **een node toevoegen** worden geschreven wanneer de functie dat wordt.
Multi-tenancy voorbij de MSP-hoofdtenant komt in fase 3, dus vandaag leeft elk account in je eigen
organisatie.

Wat er wel is, is het fundament waarvan die functies afhangen en dat er niet achteraf onder te
schuiven is: authenticatie, rechten, auditing, versleuteling, lokalisatie, de jobrunner en de
uitrol. [Roadmap](roadmap.md) noemt wat elke fase toevoegt; [Bekende hiaten](known-gaps.md) is de
eerlijke lijst van wat er op dit moment bewust ontbreekt of onaf is.

---

## Waar je hierna naartoe kunt

- [Gebruikers en toegang beheren](managing-access.md) — accounts, rollen, meervoudige authenticatie, Entra ID SSO
- [Rollen en rechten](permissions.md) — wat elke rol volledig toekent
- [Deployment](deployment.md) — vereisten, upgrades, back-up, diagnose
- [Architectuur](architecture.md) — hoe het systeem in elkaar zit, en waarom

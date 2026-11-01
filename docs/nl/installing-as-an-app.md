# Velnox als app installeren

> **Vertaling.** Bron: [docs/installing-as-an-app.md](../installing-as-an-app.md) @ `af7e616`.
> **Engels is leidend.** Bij verschil tussen deze tekst en de Engelse versie geldt de Engelse tekst.

**Velnox in een eigen venster, met een eigen icoon in het Startmenu en de taakbalk — geïnstalleerd
vanuit de browser, zonder iets te downloaden.** De app is dezelfde interface als in een
browsertabblad, op dezelfde manier aangemeld; alleen de adresbalk en de tabbladen van de browser
blijven achter.

Waarom het zo gebouwd is en niet als apart programma: zie ADR-058 in
[Technologische keuzes](tech-decisions.md).

---

## Installeren

1. Open Velnox in **Microsoft Edge** of **Google Chrome** en meld je aan.
2. Open het gebruikersmenu — je naam, rechtsboven — en kies **Installeren als app**. De browser
   vraagt of je wilt installeren; bevestig. Het installatie-icoon van de browser zelf in de adresbalk
   doet hetzelfde.
3. Velnox opent in een eigen venster en staat in het Startmenu. Klik met rechts op het icoon in de
   taakbalk om het vast te maken.

De app deelt het browserprofiel waaruit hij geïnstalleerd is: daar aangemeld is hier aangemeld, en
afmelden in het ene meldt je af in het andere. Verwijderen doe je via het menu **⋯** in de titelbalk
van de app, **Verwijderen**, of in Windows onder **Instellingen → Apps**.

Andere browsers: Safari op macOS zet elke pagina in het Dock met **Archief → Voeg toe aan Dock**;
Firefox houdt Velnox in een tabblad.

## Als "Installeren als app" er niet staat

Het menu toont het onderdeel alleen als de browser aanbiedt te installeren. Dat doet hij niet als:

- Velnox al geïnstalleerd is — in de app zelf staat het onderdeel er niet;
- het venster een privévenster is;
- de browser geen Edge of Chrome is;
- de browser het certificaat van de server niet vertrouwt. Het menu zegt dat dan: *Installeren als
  app vraagt een certificaat dat deze browser vertrouwt.*

**Een vertrouwd certificaat.** Browsers installeren een app alleen vanaf HTTPS dat ze vertrouwen.
Met een Let's Encrypt-certificaat of een eigen certificaat (zie
[Certificaten](deployment.md#certificaten)) is dat al zo. Met het zelfondertekende certificaat — de
standaard van het installatieprogramma — moet elke werkplek de certificaatautoriteit vertrouwen die
Caddy voor deze installatie maakte. Exporteer het rootcertificaat op de Velnox-host:

```bash
cd /opt/velnox && sudo docker compose -f deploy/compose/docker-compose.yml --env-file .env exec -T caddy cat /data/caddy/pki/authorities/local/root.crt > velnox-root.crt
```

en importeer `velnox-root.crt` op de werkplek in **Vertrouwde basiscertificeringsinstanties**
(Windows: open het bestand, **Certificaat installeren → Lokale computer**); voor veel werkplekken via
Groepsbeleid. Start daarna de browser opnieuw.

Een root vertrouwen is een beslissing, geen formaliteit: de werkplek vertrouwt dan elk certificaat
dat die autoriteit ondertekent, en haar sleutel staat op de Velnox-host. Is dat meer dan je wilt,
gebruik dan Let's Encrypt of een eigen certificaat.

## Wat er op de computer bewaard wordt

Alleen de eigen programmabestanden van de interface — JavaScript, stijlen en iconen, voor elke
gebruiker hetzelfde en genoemd naar hun inhoud. Nooit een antwoord van de API, een pagina, of iets
van een klant of tenant: Velnox wordt op gedeelde werkplekken gebruikt, en niets van een sessie mag
daar achterblijven.

- **Afmelden** wist wat bewaard was. De aanmeldpagina die volgt, bewaart opnieuw haar eigen
  programmabestanden, en verder niets.
- **Een nieuwe versie van Velnox** vervangt ze: de bestanden van de oude versie worden verwijderd.
- **Zonder verbinding met de server** toont de app een pagina die zegt dat Velnox niet bereikbaar is
  — niets van eerder.

## Nadat de server bijgewerkt is

Een open venster merkt de nieuwe versie wanneer het weer naar voren komt, en biedt **Herladen** aan.
Tot dan werkt het verder met de versie waarmee het geopend is.

## Ontlast het de server?

Het installeren zelf niet: de app leest dezelfde gegevens van dezelfde server als een
browsertabblad, en alleen zijn programmabestanden komen van de schijf in plaats van het netwerk, wat
de cache van een browser grotendeels al deed.

Wat wel helpt, is hoe open schermen actueel blijven, in de app en in een tabblad. Een scherm leest
zijn gegevens niet meer om de paar seconden opnieuw: de server laat weten wanneer er iets veranderde
wat het toont — een job, een gast, een node — en dan leest het opnieuw, nooit vaker dan jouw
verversinstelling. Een scherm waarop niets gebeurt, kost de server vrijwel niets. Zie ADR-059 in
[Technologische keuzes](tech-decisions.md).

## Problemen oplossen

| Wat je ziet | Wat het betekent |
|---|---|
| *Installeren als app vraagt een certificaat dat deze browser vertrouwt.* | De browser weigerde het achtergrondscript van de app, zoals hij doet bij een certificaat dat hij niet vertrouwt. Zie [een vertrouwd certificaat](#als-installeren-als-app-er-niet-staat). |
| Geen **Installeren als app** in het menu, en geen melding | De browser biedt het niet aan: geen Edge of Chrome, een privévenster, of al geïnstalleerd. |
| *Velnox is niet bereikbaar* | De computer heeft geen verbinding met de Velnox-server. **Opnieuw proberen** zodra die er is. |
| *Velnox is bijgewerkt. Herlaad om de nieuwe versie te gebruiken.* | De server draait een nieuwere versie dan het open venster. **Herladen**. |

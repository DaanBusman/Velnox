# De ISO-bibliotheek

> **Vertaling.** Bron: [docs/managing-the-library.md](../managing-the-library.md) @ `2c5fd66`.
> **Engels is leidend.** Bij verschil tussen deze tekst en de Engelse versie geldt de Engelse tekst.

**Eén plek voor de installers en disk-images waar je clusters mee worden gebouwd.** De bibliotheek
staat op de Velnox-host en bevat ISO's en cloud images voor alle klanten tegelijk. Van daaruit wordt
een bestand in één stap naar de opslag van elk cluster gekopieerd, en een bestand dat al op een
cluster staat kan ernaar terug worden gekopieerd.

Wie wat mag, staat in [Rollen en rechten](permissions.md). Waarom de bibliotheek werkt zoals hij
werkt, staat in ADR-037 en ADR-038 in [Technologiekeuzes](tech-decisions.md). Voor de schijf, zie
[De schijf van de ISO-bibliotheek](deployment.md#de-schijf-van-de-iso-bibliotheek).

---

## Wat erin staat

| Soort | Bestandsnamen | Gebruikt voor |
|---|---|---|
| **ISO** | `.iso` | Installers — vooral Windows, waarvoor geen cloud image bestaat. |
| **Disk-image** | `.qcow2`, `.raw`, `.img` | Cloud images voor Linux — de `.img`-bestanden van Ubuntu zijn van binnen qcow2. |

Bestandsnamen houden zich aan de tekens die Proxmox laat staan: letters, cijfers, punten, streepjes en
underscores. Twee bestanden waarvan de namen alleen in hoofdletters verschillen kunnen niet allebei in
de bibliotheek staan, omdat sommige opslag waar Proxmox op draait er één bestand van zou maken.

**Het bestand wordt gecontroleerd, niet vertrouwd.** Een bestand dat `.iso` heet moet een ISO-image
zijn en een `.qcow2` een qcow2-schijf; een foutpagina die onder de naam van een ISO is opgeslagen,
faalt bij de controle en zegt dat ook. Van elk bestand wordt onderweg naar binnen de SHA-256 berekend,
en elke kopie naar een cluster wordt daartegen gecontroleerd.

---

## Een bestand toevoegen

**ISO-bibliotheek** in de zijbalk, dan **Een bestand toevoegen**. Toevoegen vraagt `library.manage`,
dat MSP-beheerders en -engineers hebben: de bibliotheek is één schijf voor alle klanten, dus een klant
die hem vult, vult hem voor iedereen.

### Vanaf een URL

Plak een `http`- of `https`-adres en kies **Ophalen**. De worker downloadt het als job, die je kunt
volgen en annuleren. Velnox weigert op te halen van:

- loopback-, link-local- en multicastadressen, waaronder het cloud-metadata-adres `169.254.169.254`;
- de netwerken waar Velnox zelf op draait, want daar staan de database en de wachtrij;
- een URL met een gebruikersnaam of wachtwoord erin;
- een doorverwijzing van `https` naar gewoon `http`, of een keten van meer dan vijf doorverwijzingen.

Interne bestandsservers op privéadressen zijn toegestaan — daar bewaren de meeste MSP's hun ISO's.
Het adres wordt getoond en gelogd **zonder querystring**, want daar bewaren downloadlinks hun
handtekening.

### Vanaf deze computer

Kies het bestand onder **Vanaf deze computer**. Het gaat omhoog in stukken van 32 MiB, en een stuk
dat door een netwerkprobleem mislukt wordt los opnieuw verstuurd.

**Wordt de upload onderbroken** — tabblad gesloten, laptop in slaap, verbinding weg — dan blijft de
regel in de lijst staan als *Komt binnen*. Kies daar **Upload hervatten** en kies hetzelfde bestand
opnieuw: Velnox vraagt de server hoe ver hij kwam en gaat vanaf daar verder. Het moet dezelfde naam en
dezelfde grootte hebben, anders wordt het als een ander bestand geweigerd. **Pauzeren** stopt met
versturen zonder te verliezen wat al binnen was.

Een upload die een dag lang niemand hervat, wordt verwijderd, bytes en regel, zodat achtergelaten
halve uploads de bibliotheek niet vullen.

### Als de bibliotheek vol is

Er gelden twee grenzen, en de weigering noemt welke en de getallen:

- **De eigen omvang van de bibliotheek** (`VELNOX_LIBRARY_MAX_GB`), inclusief overdrachten die nog
  lopen.
- **Vrije schijfruimte die over moet blijven** (`VELNOX_LIBRARY_MIN_FREE_GB`), omdat de bibliotheek
  haar schijf deelt met de database, tenzij ze een eigen schijf heeft gekregen.

Het paneel **Ruimte** boven aan het scherm toont beide. Verwijder bestanden die je niet meer nodig
hebt, of vraag wie de server beheert de grenzen aan te passen — zie
[De schijf van de ISO-bibliotheek](deployment.md#de-schijf-van-de-iso-bibliotheek).

---

## Leesbare namen

Elk bestand wordt getoond onder een naam die uit de bestandsnaam is afgeleid:
`Windows11_25H2_Dutch.iso` wordt *Windows 11 Version 25H2* met als taal *Dutch*, en *Nederlands* voor
wie Velnox in het Nederlands gebruikt, omdat de taal als code wordt opgeslagen en in de taal van de
lezer wordt genoemd. De echte bestandsnaam staat er altijd onder, en dat is de naam die elke logregel
en elk cluster gebruikt.

Een naam afleiden uit een bestandsnaam is gissen. Is de gok fout, dan corrigeert **Hernoemen** de
titel, de taal, of beide; het bestand houdt zijn naam. Laat een veld leeg om terug te gaan naar wat
uit de bestandsnaam werd gelezen.

---

## Een bestand naar een cluster kopiëren

**Naar cluster kopiëren** bij een bestand dat *Klaar* is. Kies het cluster en een opslag; alleen
actieve opslag die dat soort bestand accepteert wordt aangeboden — `iso`-inhoud voor ISO's,
`import`-inhoud voor disk-images. Een opslag met *(gedeeld)* is dezelfde opslag op elke node, dus één
kopie dient het hele cluster.

Kopiëren vraagt `clusters.manage` **op dat cluster**, geen bibliotheekrecht: het schrijft naar de
infrastructuur van de klant.

De kopie is een job met drie stappen:

1. **Controle** — de opslag is actief, accepteert die inhoud, heeft ruimte, en heeft **nog geen**
   bestand met die naam. Een bestaand bestand wordt nooit overschreven; verwijder het eerst op het
   cluster.
2. **Upload** — verstuurd via de eigen API van Proxmox, over de vastgepinde verbinding, met de
   checksum. Proxmox controleert het bestand bij aankomst en weigert er een dat niet klopt.
3. **Bevestiging** — het bestand wordt opgezocht in Proxmox' eigen lijst van de opslag en de grootte
   wordt vergeleken.

**Geannuleerd of mislukt: er blijft niets achter op de node.** Omdat de controle bewees dat de naam
vrij was, kan een half geschreven bestand daar achteraf alleen van deze job zijn, en het wordt
verwijderd.

Disk-images gaan omhoog onder een `.qcow2`- of `.raw`-naam, omdat Proxmox aan de extensie bepaalt hoe
het een import leest. Een Ubuntu `jammy-server-cloudimg-amd64.img` komt aan als
`jammy-server-cloudimg-amd64.qcow2`.

---

## Bestanden op een cluster

De pagina van een cluster heeft een tabblad **ISO's en images**: elke ISO en importeerbare disk-image
op zijn opslag, zoals de laatste inventarisatie ze zag, met **In bibliotheek** om te zeggen of de
bibliotheek hetzelfde bestand heeft. Een kopie of verwijdering via Velnox werkt de lijst bij als ze
klaar is; een wijziging in Proxmox zelf verschijnt bij de volgende inventarisatie.

**Verwijderen** haalt het bestand van de opslag van het cluster, als job. De kopie in de bibliotheek
blijft staan. Verwijderen vraagt `clusters.manage` op dat cluster.

**Een bestand uit de bibliotheek verwijderen** doet het omgekeerde: de kopie in de bibliotheek gaat
weg, en kopieën die al op clusters staan blijven waar ze zijn.

---

## Een bestand van een cluster naar de bibliotheek kopiëren

De API van Proxmox kan een bestand op een opslag zetten en er een verwijderen, maar kan er geen
teruggeven. Daarom vraagt **Naar bibliotheek kopiëren** op het tabblad **ISO's en images** om **SSH**
op dat cluster, eenmalig ingesteld onder het tabblad **Verbinding** van het cluster. Al het andere in
Velnox werkt zonder.

### Wat Velnox via SSH doet

Het opent SFTP en leest één bestand. Het voert nooit een commando uit en opent nooit een shell. Het
account kan dus een account zijn dat verder niets mag, en dat hoort ook — op elke node:

```
Match User velnox-sftp
    ForceCommand internal-sftp
    AllowTcpForwarding no
    X11Forwarding no
```

in `/etc/ssh/sshd_config`, met leestoegang tot de opslagmappen — `/var/lib/vz/template/iso` en
`/var/lib/vz/import` voor de opslag `local`.

### Instellen

1. **Host keys lezen.** Velnox maakt verbinding met elke online node en legt de sleutel vast die hij
   toont, **zonder in te loggen**: er wordt geen account en geen sleutel aangeboden aan een node die
   niemand heeft bevestigd.
2. **Vergelijk** elke vingerafdruk met de node zelf voordat je hem bevestigt:

   ```bash
   ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
   ```

3. Vul de **Gebruikersnaam** in en de **Private key** waarvan de publieke helft in de
   `authorized_keys` van dat account staat, en een wachtwoordzin als de sleutel er een heeft.
4. **Opslaan en de bevestigde nodes vertrouwen.** Velnox slaat de sleutel versleuteld op en bewijst dat
   hij SFTP opent op elke bevestigde node. Weigert een node, dan wordt er niets opgeslagen en blijft de
   vorige instelling, als die er was, zoals hij was.

De private key wordt nooit meer getoond, door geen enkel scherm en geen enkele API-aanroep.
**Sleutel vervangen** doorloopt dezelfde stappen met een nieuwe; **SSH verwijderen** verwijdert de
sleutel en de vastgepinde host keys.

**Een node waarvan de host key verandert, wordt geweigerd**, net zoals een veranderd TLS-certificaat.
Stel na het herinstalleren van een node SSH opnieuw in en bevestig zijn nieuwe sleutel bewust. Met een
node die later aan het cluster wordt toegevoegd, wordt geen verbinding gemaakt tot je hetzelfde doet.

### De kopie

Een job: die vraagt Proxmox waar het bestand staat, kopieert het via SFTP naar de bibliotheek, en
doet dezelfde controle als bij elk ander binnenkomend bestand. Geannuleerd of mislukt: er blijft niets
achter in de bibliotheek.

---

## Waar het misgaat

| Wat je ziet | Wat het betekent |
|---|---|
| *De bibliotheek zou over haar limiet … gaan* | De eigen omvangsgrens van de bibliotheek. Verwijder bestanden, of verhoog `VELNOX_LIBRARY_MAX_GB`. |
| *Dan blijft er … minder over dan het minimum* | De schijf is bijna vol. Maak ruimte vrij op de host, of verlaag `VELNOX_LIBRARY_MIN_FREE_GB`. |
| *… is niet wat de naam zegt* | De bytes passen niet bij de extensie. Meestal een foutpagina onder de naam van een ISO — open de URL in een browser. |
| *Velnox haalt niets op van dat adres* | Een van de weigeringen onder [Vanaf een URL](#vanaf-een-url). |
| *… staat al op die opslag* | Verwijder het eerst op het cluster; Velnox overschrijft niet. |
| *Opslag … accepteert geen …-inhoud* | Zet `ISO image`- of `Import`-inhoud aan op de opslag in Proxmox, of kies een andere. |
| *Proxmox ontving … met een andere checksum* | Het bestand veranderde onderweg. Kopieer het opnieuw; herhaalt het zich, verdenk dan het netwerkpad. |
| *Het bestand is van de schijf van de bibliotheek verdwenen* | Iets heeft het op de host verwijderd. Verwijder de regel en voeg het bestand opnieuw toe. |
| *Deze upload is nooit afgemaakt* | Hij bleef een dag onafgemaakt staan en is verwijderd. |
| *Een bestand naar de bibliotheek kopiëren vereist SSH* | Stel SSH in onder het tabblad **Verbinding** van het cluster. |

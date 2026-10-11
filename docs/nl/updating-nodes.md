# Nodes bijwerken

> **Vertaling.** Bron: [docs/updating-nodes.md](../updating-nodes.md) @ `c313310`.
> **Engels is leidend.** Bij verschil tussen deze tekst en de Engelse versie geldt de Engelse tekst.

**Wat elke node zou bijwerken, één node bijwerken, en het beleid dat bepaalt wanneer.** Velnox leest
bij elke inventarisatie de wachtende pakketten van elke node, classificeert ze, merkt op wanneer een
node een herstart nodig heeft, en past updates node voor node toe als een job die je regel voor regel
kunt volgen. Een **rolling update** doet een heel cluster, node na node, en verplaatst de draaiende
gasten van elke node vóór zijn herstart en zet ze daarna terug.

Voor wie wat mag, zie [Rollen en rechten](permissions.md). Voor waarom het zo werkt, zie ADR-046,
ADR-047 en ADR-048 in [Technische beslissingen](tech-decisions.md).

---

## Wat Velnox uitleest

**Bewerkingen → Updates & upgrades**, tabblad **Nodes**. Elke inventarisatie leest per online node
wat apt zou installeren en welke kernels geïnstalleerd zijn:

- **Beveiliging** — updates uit het beveiligingsarchief van Debian. De inventarisatie leest dit uit
  wat de API van Proxmox meldt, wat een zwakker signaal is; de updatejob leest het opnieuw uit
  `apt-get -s` via SSH, dat het archief precies noemt, en zegt dat in zijn uitvoer.
- **Kernel** — een nieuwe kernel, die pas na een herstart werkt.
- **Proxmox** — de eigen pakketten van Proxmox: `pve-*`, `proxmox-*`, `qemu-server`, Ceph, ZFS en
  dergelijke.
- **Herstart nodig** — er is een nieuwere kernel geïnstalleerd dan de draaiende, of de node zegt het
  zelf (`/var/run/reboot-required`). De reden staat in de rij van de node.

**Pakketten** toont ze, beveiligingsupdates eerst. Hiervoor is geen SSH nodig; het is de API van
Proxmox.

---

## Voordat je updates kunt toepassen: SSH

De API van Proxmox kan de pakketlijsten verversen en een node herstarten, maar geen pakketten
installeren. Updates toepassen vereist daarom **SSH op het cluster**, ingesteld onder het tabblad
**Verbinding** van het cluster zoals voor
[een bestand naar de bibliotheek kopiëren](managing-the-library.md), met de hostsleutel van elke node
bevestigd. Een node zonder bevestigde sleutel toont *Vereist SSH*.

**Wat Velnox uitvoert.** Alleen opdrachten uit een vaste lijst in Velnox zelf — nooit een die iemand
typte of die via de API binnenkwam. Voor updates drie:

| Opdracht | Wijzigt de node | Vereist root |
|---|---|---|
| `apt-get -s -o Debug::NoLocking=1 dist-upgrade` | Nee | Nee |
| `apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold dist-upgrade` | Ja | Ja |
| een controle op `/var/run/reboot-required` | Nee | Nee |

Elke opdracht draait met `LC_ALL=C`, en pas nadat is gecontroleerd dat de machine die antwoordt heet
zoals de node heet — een opdracht bedoeld voor `pve2` weigert overal anders te draaien.

**Het account.** Root werkt. Een eigen account is beter: geef het de sleutel die Velnox bewaart, en
laat het precies de dist-upgrade via sudo zonder wachtwoord uitvoeren, in `/etc/sudoers.d/velnox`:

```
velnox ALL=(root) NOPASSWD: /usr/bin/env LC_ALL\=C DEBIAN_FRONTEND\=noninteractive apt-get -y -o Dpkg\:\:Options\:\:\=--force-confdef -o Dpkg\:\:Options\:\:\=--force-confold dist-upgrade
```

sudoers wil `:`, `=` en `,` in de argumenten van een opdracht ge-escaped met een backslash, zoals
hierboven; controleer het bestand met `visudo -cf /etc/sudoers.d/velnox`. Velnox zet `sudo -n` voor
die ene opdracht als het account geen root is, en faalt in plaats van te wachten als sudo om een
wachtwoord zou vragen. Een account dat beperkt is tot SFTP (`ForceCommand internal-sftp`) houdt het
kopiëren naar de bibliotheek werkend en laat updates mislukken met *exitcode 126*.

---

## Eén node bijwerken

**Bijwerken** in de rij van de node, met wat er met een herstart moet gebeuren:

- **Herstarten indien nodig** — de standaard: alleen als er een nieuwere kernel is geïnstalleerd of de
  node erom vraagt.
- **Nooit herstarten** — de herstart blijft nodig, en de rij zegt dat.
- **Altijd herstarten**.

De job, stap voor stap:

1. **check** — het cluster heeft quorum, de node is online, SSH bereikt hem. Hij zegt ook hoeveel
   gasten er op de node draaien.
2. **approve** — alleen onder een beleid dat om goedkeuring vraagt: de job wacht op iemand met
   `updates.execute` en `jobs.approve`.
3. **window** — alleen onder een beleid met een venster: het venster moet nog open zijn, anders
   verandert er niets.
4. **refresh** — `apt-get update`, via de API van Proxmox.
5. **simulate** — wat de dist-upgrade zou doen, pakket voor pakket, met waar elk vandaan komt.
6. **upgrade** — de dist-upgrade, met zijn uitvoer in de job terwijl hij draait. **Hij is niet
   halverwege te annuleren**: annuleren wacht tot hij klaar is, want een dpkg die halverwege stopt is
   een node die iemand met de hand moet repareren. En niets wat hij installeert is terug te draaien.
7. **reboot** — als de keuze hierboven dat zegt, en alleen als het cluster quorum houdt terwijl de
   node weg is. Proxmox sluit de gasten van de node af bij een herstart; om ze eerst te verplaatsen,
   gebruik je een [rolling update](#een-heel-cluster-bijwerken-rolling-update). Velnox wacht tot de node terug is, tot twintig minuten, en meldt op welke kernel hij
   terugkwam.
8. **verify** — leest wat er over is. Wat nog wacht — tegengehouden, of nieuw sindsdien — wordt
   gemeld.

Er wijzigt maar één job tegelijk een cluster: een update wacht achter elke andere job op hetzelfde
cluster.


---

## Een heel cluster bijwerken: rolling update

Kies een cluster op het tabblad **Nodes**. De kaart **… node voor node bijwerken** toont het plan:
welke nodes samen down gaan, in welke volgorde, en de draaiende gasten die elk zou verplaatsen. Ze
waarschuwt als de andere nodes het geheugen voor de gasten van een node niet hebben, en zegt waarom
als een run niet kan beginnen.

- **Nodes tegelijk** — standaard één. Het meeste dat een cluster toelaat is ⌊(n−1)/2⌋ bij *n*
  nodes: één bij drie of vier nodes, twee bij vijf of zes. Meer wordt geweigerd, omdat het cluster
  met meer nodes weg quorum verliest en elke gast erop stopt.
- **Herstart** — zoals bij één node.
- **Een gast die niet live kan verhuizen** — een gast met een schijf op de eigen opslag van een node
  (`local`, `local-lvm`, een ZFS-pool die alleen die node heeft) of een doorgegeven apparaat
  (`hostpci`, `usb`) kan niet naar een andere node verhuizen terwijl hij draait. **Niet beginnen**
  weigert de run en noemt ze; **Afsluiten voor de herstart van zijn node, daarna starten** doet
  precies dat.
- **Minuten om te stabiliseren** — hoe lang een node, het cluster en Ceph mogen doen om na een
  herstart weer heel te zijn voordat de run stopt. Standaard tien.
- **Gasten daarna terugzetten** — standaard aan. Uit blijven ze waar ze heen verplaatst zijn en
  zegt de job waar dat is.

De job, stap voor stap:

1. **preflight** — weigert een cluster dat al gedegradeerd is: een node offline, geen quorum, Ceph
   niet `HEALTH_OK`. Ze leest de configuratie van elke draaiende gast uit Proxmox om te bepalen
   welke kunnen verhuizen, en controleert dat de gasten van elke groep passen in het geheugen dat
   de andere nodes vrij hebben. Weigert ze, dan is er nog niets veranderd.
2. **approve** en **window** — zoals bij één node, onder het beleid van het cluster. Het venster
   wordt vóór elke groep opnieuw gecontroleerd: een venster dat halverwege sluit, stopt de run na
   de groep die bezig is.
3. Dan, voor elke groep om de beurt:
   - **evacuate** — elke draaiende gast live verplaatst naar de online node buiten de groep die de
     [plaatsingsregels](placement.md) toestaan, een voorkeursnode eerst, daarna die met het meeste
     vrije geheugen; containers verhuizen met een herstart, zoals Proxmox een draaiende
     container verplaatst. Een gast die niet kan verhuizen wordt afgesloten, als je dat koos.
   - **update** — refresh, simulate en dist-upgrade op elke node van de groep, zoals bij één node.
   - **reboot** — volgens de herstartkeuze, en alleen als quorum het toelaat met de groep weg.
   - **validate** — wacht tot de nodes van de groep weer online zijn, alle nodes van het cluster
     dat zijn, het cluster quorum heeft en Ceph `HEALTH_OK` is.
   - **return** — elke gast terug naar de node waar hij vandaan kwam, elke afgesloten gast weer
     gestart.
4. **summary** — hoeveel nodes zijn bijgewerkt, hoeveel gasten verplaatst of afgesloten en hoeveel
   terug waar ze waren; wie dat niet is, met naam, en waar die nu staat.

**Als het misgaat.** Een fout in de eerste groep laat de job mislukken. Een fout nadat een groep klaar
is — een node die niet op tijd valideert, een gast die niet wil verhuizen — stopt de run als
**gedeeltelijk geslaagd**: de groepen ervoor zijn klaar, de groepen erna niet begonnen. Hoe dan ook
zegt de job welke gasten verplaatst en niet teruggezet zijn, en waar ze nu staan. Los op wat ze
noemt en start een nieuwe rolling update: nodes zonder wachtende updates gaan snel.

De job neemt het cluster: node-updates en andere wijzigingen op hetzelfde cluster wachten erachter.

---

## Onderhoudsvensters

Tabblad **Onderhoudsvensters**. Een venster hoort bij een tenant en wordt gebruikt door het beleid
van die tenant. Het is een regel voor wanneer het opengaat, hoe lang het open blijft, en een
tijdzone; het gaat op de dagen dat de klok verzet wordt op dezelfde lokale tijd open, en in de nacht
dat de klok teruggaat de eerste van de twee keren.

Het formulier bouwt de regel — elke dag, elke week op gekozen dagen, of elke maand op een dagnummer
of een weekdag zoals *de laatste zaterdag* (`-1SA`) — en toont wanneer het weer opengaat. **De regel
zelf schrijven** neemt direct een RFC 5545-regel: `FREQ` (`DAILY`, `WEEKLY`, `MONTHLY`) met `BYDAY`,
`BYMONTHDAY`, `BYHOUR` en `BYMINUTE`. Al het andere — `INTERVAL`, `COUNT`, `UNTIL` — wordt geweigerd
in plaats van geraden. **Niet op deze datums** slaat hele lokale datums over, zoals een bevriezing
voor een feestdag.

---

## Beleid

Tabblad **Beleid**. Eén beleid per cluster; een cluster zonder beleid wordt alleen met de hand
bijgewerkt, op elk moment.

- **Onderhoudsvenster** — updates onder het beleid draaien alleen terwijl het open is. **Bijwerken**
  daarbuiten wordt geweigerd, met wanneer het weer opengaat, in plaats van in de wachtrij gezet.
- **Vereist goedkeuring** — elke update onder het beleid wacht op goedkeuring, met de hand of door het
  beleid gestart.
- **Herstart** — de standaard voor updates onder het beleid.
- **Werkt zichzelf bij** — als het venster opengaat, werkt Velnox de nodes van het cluster met
  wachtende updates bij, **één node tegelijk**: de volgende begint pas als de vorige klaar is en, als
  hij herstartte, terug is. Een node wordt één keer per opening geprobeerd, dus een node waarvan de
  update mislukte wordt niet elke minuut opnieuw geprobeerd. Vereist een venster: een beleid dat
  zichzelf op elk uur bijwerkt wordt geweigerd.

Beleid en vensters vereisen `updates.manage`; een node of een heel cluster bijwerken vereist
`updates.execute`. Een beleid dat zichzelf bijwerkt doet één node tegelijk, geen rolling update: het
verplaatst geen gasten.

---

## Geschiedenis

Tabblad **Geschiedenis**: elke node-update en rolling update, door een persoon of door een beleid, nieuwste eerst. Open
er een voor de uitvoer, stap voor stap.

---

## Waar het misgaat

| Wat je ziet | Wat het betekent |
|---|---|
| *Vereist SSH op het cluster* | Stel SSH in onder het tabblad **Verbinding** van het cluster en bevestig de hostsleutel van deze node. |
| *… staat updates alleen toe in venster …, dat niet open is* | Het beleid van het cluster heeft een venster. Wacht erop, wijzig het venster, of schakel het beleid uit. |
| *Het onderhoudsvenster sloot voordat de update iets ging wijzigen* | De job wachtte op goedkeuring tot na het einde van het venster. Er is niets gewijzigd; werk opnieuw bij in het volgende venster. |
| *… eindigde met exitcode 126* | Het account mag geen opdrachten uitvoeren — meestal een account dat alleen SFTP mag. Zie [het account](#voordat-je-updates-kunt-toepassen-ssh). |
| *… eindigde met exitcode 1* van `sudo` | sudo vroeg om een wachtwoord, of staat precies die opdracht niet toe. Controleer `/etc/sudoers.d/velnox`. |
| *apt.dist_upgrade … eindigde met exitcode 100* | apt of dpkg mislukte. De uitvoer van de job bevat de eigen woorden van apt; los het op de node op (`dpkg --configure -a`) en werk daarna opnieuw bij. |
| *De machine die voor … werd bereikt heet niet …* | SSH bereikte een machine met een andere naam. Controleer het adres van de node en de SSH-instelling. |
| *Het cluster zou geen quorum houden* | Een andere node is down. De updates zijn geïnstalleerd; de herstart is niet gedaan. Breng de andere node terug en werk dan opnieuw bij met herstart. |
| *… kwam niet binnen 20 minuten terug* | Kijk naar de console van de node. |
| De herstart blijft nodig na een herstart | De node startte een oudere kernel; controleer zijn opstartvolgorde (`proxmox-boot-tool kernel list`). |
| *Het cluster is gedegradeerd …* | Een node is offline, het cluster heeft geen quorum of Ceph is niet gezond. Een rolling update begint pas als het heel is. |
| *Deze draaiende gasten kunnen niet live verhuizen …* | Hun schijf staat op de eigen opslag van een node, of er is een apparaat doorgegeven. Verplaats of stop ze, of kies ervoor ze af te sluiten voor de herstart. |
| *Terwijl … down is, hebben zijn gasten … GB nodig* | De andere nodes hebben dat geheugen niet vrij. Stop gasten die je kunt missen, of voeg geheugen toe. |
| *… kwam na de update niet heel terug* | De node kwam terug, maar het cluster of Ceph was niet op tijd heel. De job noemt wat er mis was en welke gasten niet teruggezet zijn. |

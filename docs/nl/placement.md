# Plaatsing

> **Vertaling.** Bron: [docs/placement.md](../placement.md) @ `1e88691`.
> **Engels is leidend.** Bij verschil tussen deze tekst en de Engelse versie geldt de Engelse tekst.

**Welke gasten van een cluster uit elkaar of bij elkaar worden gehouden, op welke nodes een gast
hoort, en hoe Velnox dat zo houdt.** Een regel stel je één keer in en blijft waar: Velnox meldt
wanneer hij niet klopt, kan gasten verplaatsen om hem na te leven, houdt hem aan terwijl een rolling
update een node leegmaakt, en schrijft hem op Proxmox VE 9 in de eigen HA-regels van Proxmox, zodat
hij blijft gelden terwijl Velnox niet draait.

Voor wie wat mag, zie [Rollen en rechten](permissions.md). Voor waarom het zo werkt, zie ADR-049 in
[Technische beslissingen](tech-decisions.md).

---

## Regels

**Beheer → Plaatsing**, en kies een cluster. **Nieuwe regel**, van een van drie soorten:

- **Uit elkaar houden** — deze gasten draaien nooit op dezelfde node. Voor de twee helften van een
  cluster, een database en zijn replica, twee domeincontrollers. Meer gasten dan het cluster nodes
  heeft, kunnen niet uit elkaar worden gehouden, en dat wordt geweigerd.
- **Bij elkaar houden** — deze gasten draaien altijd op dezelfde node. Voor gasten die voortdurend
  met elkaar praten.
- **Voorkeur voor nodes** — deze gasten draaien op de gekozen nodes. **Alleen deze nodes** maakt het
  strikt: een gast komt nooit ergens anders, ook niet als geen van die nodes hem kan hebben. Uit gaat
  een gast elders heen als het moet, en komt terug als het kan.

Een regel noemt gasten, bij hun VMID, en alleen draaiende gasten tellen: een gestopte gast staat
nergens, dus breekt geen regel. Dezelfde twee gasten kunnen niet door de ene regel uit elkaar en door
een andere bij elkaar worden gehouden; de tweede wordt geweigerd, met de naam van de eerste. Een regel
die uit staat, blijft bestaan en telt nergens voor.

Elke regel zegt of hij **klopt**, uit de inventaris — een gast die buiten Velnox om verplaatst is, zie
je dus bij de volgende inventarisatie — en zo niet, welke gasten waar staan.

---

## Op Proxmox VE 9: de eigen HA-regels van Proxmox

Als elke node van het cluster PVE 9 draait, is elke regel ook een van de HA-regels van Proxmox, met de
naam `velnox-` en het eerste deel van het id van de regel: **uit elkaar** en **bij elkaar houden** als
*resource affinity* (negatief en positief), **voorkeur voor nodes** als *node affinity*, strikt of
niet. Velnox schrijft hem binnen een halve minuut na het opslaan, leest hem terug, en zegt dat bij de
regel:

| Wat de regel zegt | Wat het betekent |
|---|---|
| *In de HA-regels van Proxmox* | Proxmox heeft de regel precies zoals Velnox hem schreef. |
| *Wordt naar Proxmox geschreven* | Opgeslagen in Velnox; de worker heeft hem nog niet geschreven. |
| *Niet in Proxmox* | Proxmox weigerde hem, of hij kon niet worden gelezen. De reden staat onder de regel. |
| *Bewaakt door Velnox* | PVE 8, of een cluster dat nog bezig is met upgraden: Proxmox heeft hier geen regels voor, en Velnox bewaakt ze door gasten te verplaatsen. |

De regel van Velnox is degene die telt: een `velnox-`-regel die in Proxmox gewijzigd of verwijderd
is, wordt opnieuw geschreven. Een regel die in Velnox verwijderd is, wordt uit Proxmox verwijderd en
daarna uit Velnox. De andere HA-regels van Proxmox blijven ongemoeid.

De HA-manager van Proxmox past zijn regels toe op gasten die hij beheert — gasten die zijn toegevoegd
onder **Datacenter → HA**. Velnox voegt niet uit zichzelf gasten aan HA toe, want dat verandert wat er
gebeurt als een node uitvalt. Een gast buiten HA wordt door de eigen verplaatsingen van Velnox
bewaakt, op PVE 9 net als op PVE 8.

---

## Corrigeren

**Nu corrigeren** start een job die draaiende gasten live verplaatst tot elke regel klopt, zonder een
andere regel te breken: de strikte regels eerst, van twee gasten die uit elkaar moeten verhuist de
kleinste, gasten die bij elkaar moeten gaan naar waar de meeste al staan, en een gast gaat alleen naar
een node met het geheugen voor hem. Wat niet kan — geen node met ruimte, een gast die niet live kan
verhuizen — staat in de job, met naam.

De job, stap voor stap:

1. **check** — het cluster is heel: quorum, elke node online, Ceph `HEALTH_OK`. Plaatsing verplaatst
   niets op een cluster dat dat niet is.
2. **plan** — uit wat Proxmox nu zegt, niet uit de inventaris: de verplaatsingen, en wat niet kan.
3. **move** — elke verplaatsing om de beurt, vlak ervoor opnieuw aan de regels getoetst.
4. **verify** — de regels opnieuw gelezen. Een regel die nog niet klopt, laat de job mislukken; als
   er verplaatsingen gedaan zijn, eindigt hij als **gedeeltelijk geslaagd**, en die verplaatsingen
   blijven staan.

---

## Balanceren

**Nu balanceren** verplaatst hoogstens één gast: de kleinste gast op de node die het meeste van zijn
geheugen gebruikt die, verplaatst naar een rustigere node, het verschil tussen de drukste en de
rustigste kleiner maakt — nooit tegen een regel in, nooit naar een node die een zachte voorkeur lager
rangschikt. Zolang het verschil binnen de drempel blijft, verplaatst het niets. Balanceren gaat op
geheugen, want dat bepaalt of een gast past; CPU-gebruik verandert van minuut tot minuut.

---

## Zo houden

Onder **Zo houden**, allebei uit tot je ze aanzet:

- **Zelf corrigeren** — als de inventaris een regel laat zien die niet klopt, start Velnox een
  correctie.
- **Zelf het geheugen balanceren** — als de drukste node meer van zijn geheugen gebruikt dan de
  rustigste, met meer dan de **drempel** (procentpunten, 5–80), start Velnox een balanceerrun.

Nooit terwijl het cluster niet heel is — een node offline of quorum weg — nooit terwijl een andere job
het cluster wijzigt, en hoogstens één keer per **rustperiode** (minuten). Een run die zo gestart is,
zegt dat in zijn geschiedenis: *door de instellingen*.

---

## Rolling updates

Een [rolling update](updating-nodes.md#een-heel-cluster-bijwerken-rolling-update) houdt zich aan de
regels terwijl hij elke node leegmaakt: een gast gaat alleen naar een node die de regels toestaan, een
voorkeursnode eerst. Als geen node mag — een gast die strikt gebonden is aan de node die wordt
leeggemaakt, bijvoorbeeld — weigert de rolling update voordat hij begint, met de gast en de regel. Een
gast wordt niet teruggezet op zijn eigen node als dat nu een regel zou breken; de job zegt waar hij
blijft.

---

## Waar het misgaat

| Wat je ziet | Wat het betekent |
|---|---|
| *Het cluster heeft geen gast of node …* | De regel noemt een VMID of node die de inventaris niet heeft. Inventariseer het cluster opnieuw als het nieuw is. |
| *… gasten kunnen niet uit elkaar worden gehouden op … nodes* | Meer gasten dan nodes. Splits de regel. |
| *Dezelfde gasten worden andersom gehouden door regel …* | Twee regels spreken elkaar tegen. Wijzig er een of zet er een uit. |
| *Het cluster is niet heel …* | Een node is offline, het quorum is weg, of Ceph is niet gezond. Er wordt niets verplaatst tot het heel is. |
| *Sommige plaatsingsregels kloppen nog niet …* | Geen node met de ruimte, of een gast die niet live kan verhuizen (een schijf op de eigen opslag van een node, een doorgegeven apparaat). |
| *Niet in Proxmox* bij een regel | Proxmox weigerde de regel; de reden staat eronder. Op een cluster dat midden in een upgrade zit, bewaakt Velnox de regel tot elke node PVE 9 draait. |
| *Geen node mag … hebben terwijl zijn eigen node wordt leeggemaakt* | Een rolling update zou een regel moeten breken. Wijzig de regel voor de update, of stop de gast. |

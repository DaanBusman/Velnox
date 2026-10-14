# Grote upgrades

> **Vertaling.** Bron: [docs/major-upgrades.md](../major-upgrades.md) @ `5554f64`.
> **Engels is leidend.** Bij verschil tussen deze tekst en de Engelse versie geldt de Engelse tekst.

**Plannen die een cluster doel voor doel upgraden, de controles vooraf, de herstelacties, en het
rapport erna.** Een plan draait één playbook — een Ceph-upgrade, een Proxmox VE-upgrade — of, als
*samengesteld* plan, meerdere plannen na elkaar: eerst Ceph, dan Proxmox VE. Beide playbooks staan
hieronder. De eigen zelftests van de engine, die niets buiten Velnox veranderen, zijn er ook.

Voor wie wat mag, zie [Rollen en rechten](permissions.md). Voor waarom het zo werkt, zie ADR-050 in
[Technische beslissingen](tech-decisions.md).

---

## Plannen

**Beheer → Updates & upgrades**, tabblad **Grote upgrades** — ook op `/major-upgrades`. **Nieuw
plan**: een cluster, een playbook en een naam. De doelen komen uit de inventaris als het plan wordt
gemaakt, in de volgorde waarin ze geüpgraded worden: nodes op naam; Ceph-daemons in de eigen
volgorde van Ceph — monitors, dan managers, OSD's, MDS en RGW.

Een plan dat nog niet gedraaid heeft, kan gestart of verwijderd worden. Eenmaal gestart kan het niet
opnieuw gestart of verwijderd worden: zijn vastlegging en zijn rapport blijven.

---

## Hoe een plan draait

Elk playbook gaat door dezelfde fasen, als één job die je stap voor stap kunt volgen:

1. **Discovery** — wat de guards lezen: het quorum van het cluster, nodes die offline zijn, de
   versies van Proxmox VE, de gezondheid van Ceph.
2. **Preflight** — de controles van het playbook, elke bevinding `PASS`, `INFO`, `WARNING`,
   `BLOCKER` of `UNKNOWN`. Een regel die Velnox niet herkent is `UNKNOWN`, en houdt de upgrade tegen
   als een blokkade: hij wordt nooit onschuldig verondersteld. Een stap kan een *guard* hebben — een
   voorwaarde zoals "het cluster heeft quorum en geen node is offline" — die de run stopt, met wat er
   niet klopte.
3. **Herstel** — een bevinding met een herstelactie krijgt die, gerouteerd naar wat de herstelactie
   is:
   - **Door Velnox toegepast** als het risico laag is en Velnox het ongedaan kan maken.
   - **Vraagt goedkeuring** anders. De job stopt en wacht op iemand met `upgrades.execute` en
     `jobs.approve`, en toont de exacte wijziging — elk bestand regel voor regel, elk pakket, elke
     opdracht. Wat goedgekeurd wordt, is wat wordt toegepast: dezelfde vastlegging.
4. **Opnieuw controleren** — de controles draaien opnieuw. Het plan bewaart elke run, dus wat een
   herstelactie verhielp is een vergelijking, geen gok. Staat er nog iets open dat de upgrade
   tegenhoudt, dan eindigt de run hier, als **geblokkeerd**, voordat een doel is aangeraakt.
5. **Upgrade** en **validatie** — doel voor doel: het ene wordt geüpgraded en gevalideerd voordat het
   volgende begint. Een doel dat mislukt, stopt de run daar; de doelen ervoor zijn klaar, de doelen
   erna niet bereikt.
6. **Rapport** — de toestand van elk doel voor en na, wat elke controlerun vond, wat verholpen is en
   wat nog openstaat, elke herstelactie en hoe die afliep. Getoond bij het plan en te downloaden als
   Markdown, voor een ticket of een klant.

---

## Ceph: een grote upgrade

Het playbook **Ceph major upgrade** upgradet een hypergeconvergeerd Ceph-cluster één release, zoals
de handleidingen van Proxmox het doen. **Nieuw plan** met dit playbook vraagt naar de release waarnaar
geüpgraded wordt en het repositorykanaal (no-subscription of enterprise).

**De versiematrix.** Velnox upgradet alleen langs stappen die het kent, elk zoals Proxmox het
documenteert:

| Van | Naar | Vraagt minstens |
|---|---|---|
| Quincy (17) | Reef (18) | Ceph 17.2.7 |
| Reef (18) | Squid (19) | Ceph 18.2.4 en pve-manager 8.2.8 — Proxmox VE 9 vraagt Squid |

Een plan wordt niet gemaakt als de release die draait, de gevraagde release en de matrix elkaar
tegenspreken, en de weigering zegt welke van de drie onverwacht is: een cluster waarvan de daemons
verschillende releases draaien — al midden in een upgrade — of een release die Velnox niet kent, is
*de release die draait*; een release die niet nieuwer is, is *het doel*; een stap die de matrix niet
heeft, zoals Quincy rechtstreeks naar Squid, is *de matrix*. Het plan legt vast welke matrixversie het
maakte.

**Voordat er iets verandert**, leest de preflight Ceph zoals Proxmox het dan geeft, en blokkeert op:
Ceph niet `HEALTH_OK`, een placement group niet `active+clean`, een monitor buiten quorum, daemons op
verschillende releases, een waarschuwing die Velnox niet kent (letterlijk getoond, als `UNKNOWN`),
pve-manager ouder dan de stap vraagt, geen SSH op een node, en — met CephFS — MDS-daemons waarvan het
plan niet weet dat ze voorbereid zijn. `noout` dat al aan staat is een waarschuwing: Velnox laat het
zoals het was.

**Dan, op volgorde:**

1. **repository** — `/etc/apt/sources.list.d/ceph.list` op elke node gezet op de regel van Proxmox
   voor het doel, het oude bestand bewaard als `ceph.list.velnox-before`.
2. **noout** — aangezet, zodat OSD's die herstarten niet out worden gemarkeerd.
3. **packages** — `apt-get update` en de dist-upgrade op elke node. De daemons blijven de oude release
   draaien.
4. **restart** en **settle**, daemon voor daemon, in de volgorde van Ceph — monitors, managers, OSD's,
   MDS: elk herstart via Proxmox, bewezen op de nieuwe release, en Ceph opnieuw gelezen tot het heel
   is — gezond op `noout` na en de waarschuwing dat `require-osd-release` nog niet verhoogd is —
   voordat de volgende begint. Een waarschuwing die Velnox niet kent, stopt de run meteen; een die een
   herstart even veroorzaakt, zoals een monitor buiten quorum, wordt afgewacht, tot de
   stabilisatietijd (standaard tien minuten).
5. **require-release** — `ceph osd require-osd-release` verhoogd naar het doel, pas als elke OSD het
   draait.
6. **noout-unset**, dan **verify**: elke daemon op de doelrelease, `min_mon_release` het doel, Ceph
   gezond.

**noout wordt altijd uitgezet.** Als de run mislukt, geannuleerd wordt of zijn worker sterft, zet
Velnox `noout` uit als het dat zelf aanzette — dat van een gestorven worker door de volgende worker,
binnen seconden nadat die het merkt.

**CephFS.** De handleiding van Proxmox brengt elk bestandssysteem terug tot één actieve MDS en zet
standby replay uit voordat MDS-daemons herstarten. Velnox wijzigt die instellingen niet: doe het eerst,
en vink dan **CephFS is voorbereid** aan bij het plan. Zonder dat wordt een cluster met MDS-daemons
geblokkeerd.

**SSH en sudo.** De repository en de pakketten vragen SSH op elke node; het commando `ceph` vraagt de
admin-keyring van het cluster. Root is het eenvoudigst. Met een eigen account voeg je aan de
sudoregels voor updates de exacte opdrachten toe — voor Squid bijvoorbeeld:

```
velnox ALL=(root) NOPASSWD: /usr/bin/ceph osd require-osd-release squid
```

en de omschakeling van de repository, die Velnox draait als `sh -c` met de exacte regel voor het doel;
controleer de opdracht in de uitvoer van de job.

---

## Proxmox VE 8 → 9

Het playbook **Proxmox VE 8 → 9** upgradet een cluster node voor node, zoals de
[upgradehandleiding](https://pve.proxmox.com/wiki/Upgrade_from_8_to_9) van Proxmox het doet. Proxmox
VE 9 vraagt Ceph Squid: op een Ceph-cluster dat nog op Reef staat, vink **Eerst Ceph naar Squid
upgraden** aan en het plan wordt samengesteld — de [Ceph-upgrade](#ceph-een-grote-upgrade), dan,
alleen als die voltooid is, Proxmox VE. Een los Proxmox VE-plan wordt daar geweigerd.

**Eerst elke node op de laatste Proxmox VE 8.** pve8to9 bestaat pas vanaf pve-manager 8.4.2; op een
oudere node valt er niets te draaien. Daarom leest Velnox eerst de versie van elke node, en een node
onder 8.4.2 wordt naar de laatste Proxmox VE 8 op bookworm gebracht — `apt-get update` en de
dist-upgrade, via de eigen apt-bronnen van de node — na een goedkeuring die de node en zijn versie
noemt. Vóór die goedkeuring wordt niets gecontroleerd en geen node aangeraakt. Elke update wordt
bewezen doordat de node pve-manager 8.4.2 of later meldt en pve8to9 daar daarna draait zonder "te
oud" of openstaande updates. Een node die binnen 8 is bijgewerkt hoeft niet apart te herstarten: de
upgrade naar 9 herstart hem toch.

**pve8to9, gelezen.** Daarna draait Velnox `pve8to9 --full` op elke node en
bewaart elke regel die het print. Elke bevinding wordt een controle — `PASS`, `INFO`, `WARNING`,
`BLOCKER` — en een regel die Velnox niet kan plaatsen is `UNKNOWN`, wordt letterlijk getoond, en houdt
de upgrade tegen: hij wordt nooit onschuldig verondersteld. Wat Velnox met de bevindingen doet:

| pve8to9 zegt | Velnox |
|---|---|
| Het passende CPU-microcodepakket is niet gevonden | **Verhelpt het zelf:** zet het onderdeel `non-free-firmware` van Debian aan op de Debian-bronnen (het oude bestand blijft bewaard) en installeert `intel-microcode` of `amd64-microcode`. Laag risico, en ongedaan te maken. |
| Verouderde config `/etc/sysctl.conf` bevat instellingen | Na goedkeuring: elke instelling naar `/etc/sysctl.d/99-velnox-from-sysctl-conf.conf`, en uitgecommentarieerd waar ze stond. De goedkeuring toont beide bestanden regel voor regel. |
| Meta-pakket systemd-boot geïnstalleerd | Na goedkeuring: `systemd-boot` verwijderd (`systemd-boot-efi` en `systemd-boot-tools` blijven). |
| Meta-pakket grub-efi-amd64 niet geïnstalleerd | Na goedkeuring: geïnstalleerd. |
| Verwisselbare bootloader … niet ingesteld om bij te werken | Na goedkeuring: de debconf-instelling en een herinstallatie van `grub-efi-amd64`, zoals pve8to9 aanraadt. |
| LVM-autoactivatie (gedeelde opslag) | Na goedkeuring: het eigen script `pve-lvm-disable-autoactivation` van Proxmox. Op lokale opslag is het een melding, die blijft zo. |
| proxmox-ve te oud / updates beschikbaar | Na goedkeuring: de node eerst bijgewerkt op bookworm — net als een node die te oud is om pve8to9 te hebben. |
| Minder dan 5 GB vrij op `/`, containers die cgroup v1 nodig hebben, Ceph te oud, nodes offline, GlusterFS | **Blokkeert.** Niets wat Velnox kan verhelpen; het plan zegt waarom. |

Elke herstelactie wordt bewezen door pve8to9 op die node opnieuw te draaien; daarna draait de hele
controle opnieuw, en wat de upgrade nog tegenhoudt, beëindigt de run voordat een node wordt
aangeraakt.

**Dan, node voor node:**

1. **evacuate** — de draaiende gasten van de node live naar de andere verplaatst, binnen de
   [plaatsingsregels](placement.md); een gast die niet kan verhuizen wordt geweigerd, of afgesloten als
   het plan dat zegt.
2. **repositories** — elke apt-bron van bookworm naar trixie, elk bestand bewaard als
   `*.velnox-bookworm`.
3. **packages** — `apt-get update` en de dist-upgrade, met behoud van de eigen configuratiebestanden
   van de node.
4. **reboot** — met `noout` van Ceph eromheen, en alleen zolang het cluster quorum houdt.
5. **validate** — de node terug op Proxmox VE 9 en zijn nieuwe kernel, Ceph heel, `noout` uitgezet, en
   opnieuw pve8to9 zonder iets dat tegenhoudt.
6. **return** — de gasten teruggezet, de afgesloten gasten weer gestart.

**De eerste node is een kanarie.** Daarna wacht de run op iemand met `upgrades.execute` en
`jobs.approve`, en toont wat de node was en nu is, voordat de tweede node begint.

Aan het eind draait elke node Proxmox VE 9, en zet Proxmox HA-groepen zelf om naar HA-regels. Het
rapport toont van elke node de versie en de kernel voor en na.

**SSH en sudo.** pve8to9 en de herstelacties vragen root; root over SSH is het eenvoudigst. Elke
opdracht die Velnox draait ligt vast in Velnox en staat in de uitvoer van de job en in de goedkeuring.

---

## Samengestelde plannen

Een samengesteld plan draait zijn plannen op volgorde, elk als eigen job: het volgende begint als het
vorige voltooid is en het cluster vrij is. Als er een mislukt — of geblokkeerd raakt — mislukt het
samengestelde plan, en worden de plannen erna geannuleerd zonder te starten. Zijn rapport bevat de
rapporten van zijn plannen, op volgorde.

Een plan binnen een samengesteld plan wordt niet los gestart; start het samengestelde plan.

---

## De zelftests

Twee playbooks bewijzen de engine op elk cluster, aangeboden aan wie de installatie beheert
(`system.manage`): één node voor node, één Ceph-daemon voor daemon. Ze werken op een vastlegging in het
plan en veranderen niets buiten Velnox: een ontbrekende markering op elk doel die Velnox zelf
verhelpt, een configuratie die goedkeuring vraagt om te wijzigen, een blokkade die niets verhelpt, een
doel dat mislukt — gekozen als het plan wordt gemaakt.

---

## Waar het misgaat

| Wat je ziet | Wat het betekent |
|---|---|
| *Een voorwaarde voor deze stap klopt niet: …* | Een guard — bijvoorbeeld een node die offline is. Maak het cluster heel en maak dan een nieuw plan. |
| *… houden de upgrade nog tegen* | Na herstel staat er nog een blokkade of een onbekende regel open. Het plan zegt welke. |
| *… herstelactie … is mislukt* | Een herstelactie kon niet worden toegepast, of verhielp haar controle niet. De uitvoer van de job zegt waarom. |
| *De upgrade van … is mislukt* | De upgrade of de validatie van een doel mislukte. De doelen ervoor zijn klaar. |
| *Alleen een plan dat nog niet gedraaid heeft, kan gestart of verwijderd worden* | Maak een nieuw plan. |
| *Er is geen playbook …, of het wordt jou niet aangeboden* | Zelftests vragen `system.manage`. |
| *De draaiende release, het doel en de versiematrix spreken elkaar tegen* | De weigering noemt welke; zie [de versiematrix](#ceph-een-grote-upgrade). |
| *Ceph draait …, en Proxmox VE 9 vraagt Squid* | Maak het plan met **Eerst Ceph naar Squid upgraden**. |
| *Ceph is niet heel: …* | Na de herstart van een daemon kwam Ceph niet binnen de stabilisatietijd gezond terug, of toonde een waarschuwing die Velnox niet kent. `noout` is uitgezet. |

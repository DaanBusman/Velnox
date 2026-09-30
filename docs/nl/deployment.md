# Velnox — Uitrolhandleiding

> **Vertaling.** Bron: [docs/deployment.md](../deployment.md) @ `2c5fd66`.
> **Engels is leidend.** Bij verschil tussen deze tekst en de Engelse versie geldt de Engelse tekst.

Velnox draait als een set Docker-containers op een Debian- of Ubuntu-host. Dimensioneer de machine,
richt hem in voor een databasebelasting, en draai dan de installer — die doet de rest: Docker,
secrets, images, migraties en health checks.

---

## Systeemeisen

**Waar je het neerzet:** niet op een hypervisor-node die Velnox zelf beheert. Op het moment dat het die
node in onderhoud zet of herstart, zet het zichzelf uit — middenin een job. Gebruik een beheercluster
of een aparte host.

| | vCPU | RAM | Schijf |
|---|---|---|---|
| Evaluatie | 2 | 4 GB | 40 GB |
| Tot ~10 clusters / ~50 nodes | 4 | 8 GB | 80 GB |
| Tot ~50 clusters / ~300 nodes | 8 | 16 GB | 200 GB |

Debian 12 of 13, of Ubuntu 22.04 of 24.04 LTS. Uitsluitend 64-bits x86. Een minimale
serverinstallatie, met verder niets dat op poort 80 en 443 luistert.

De schijf gaat vooral op aan de container-images (~2,3 GB) en, als je op de host bouwt, aan de Docker
build cache, die ruim boven de 10 GB uitkomt. `sudo docker builder prune -f` ruimt die op. Daarna groeit de
schijf mee met auditrecords, joblogs en inventarishistorie — en met de ISO-bibliotheek, meestal de
grootste van allemaal. Zie [De schijf van de ISO-bibliotheek](#de-schijf-van-de-iso-bibliotheek).

### Poorten

Inkomend: **443** en **80** vanaf de werkplekken van operators, plus **22** voor hostbeheer.

Uitgaand, naar de infrastructuur die Velnox beheert: **8006** en **22** naar Proxmox-nodes, **443**
naar vCenter/ESXi, **5985/5986** naar Hyper-V-hosts, **443** naar Microsoft bij gebruik van Entra ID
SSO, en **123/udp** voor tijd.

PostgreSQL en Redis zijn niet bereikbaar vanaf de host of het netwerk; die draaien op een intern
Docker-netwerk zonder gepubliceerde poorten.

---

## Instellingen van de virtuele machine

Velnox is een applicatie met een database eronder. Vier dingen doen ertoe op elke hypervisor:
**geparavirtualiseerde apparaten, een vaste geheugentoewijzing, geen automatische snapshots van de
draaiende VM, en een kloppende klok.** Memory ballooning en de buffer cache van PostgreSQL werken
elkaar actief tegen, en een snapshot van een draaiende database is een crash-consistent beeld, geen
back-up.

### Proxmox VE

| Instelling | Waarde |
|---|---|
| Machine / BIOS | `q35` met `OVMF (UEFI)` en een EFI-schijf |
| CPU-type | `host` — of een gedeeld model zoals `x86-64-v3` als de VM moet kunnen live-migreren |
| Geheugen | Vast; **vink "Ballooning Device" uit** |
| SCSI-controller | `VirtIO SCSI single` |
| Schijf | Bus `SCSI`, `Discard=on`, `IO thread=on`, cache `Default (no cache)`, SSD-emulatie aan bij flash eronder |
| Netwerk | `VirtIO (paravirtualized)` |
| Guest agent | Ingeschakeld — en installeer hem ook in de guest |
| Starten bij opstarten | Ja |

```bash
sudo apt-get install -y qemu-guest-agent
```

Installeren is alles wat u in de guest doet. Voer `systemctl enable qemu-guest-agent` **niet** uit:
de unit wordt door udev gestart zodra de virtuele seriële poort verschijnt, en hem inschakelen levert
een lap tekst op over een unit zonder installatieconfiguratie — dat is systemd die correct meldt dat
het commando zinloos was, geen fout die u moet verhelpen.

Wat wél telt is het vinkje **Guest agent** in de VM-opties hierboven. Dat toevoegen is een
hardwarewijziging, dus een draaiende VM moet volledig worden gestopt en gestart — opnieuw opstarten
vanuit de guest is niet genoeg. Controleren of het gelukt is:

```bash
systemctl is-active qemu-guest-agent && ls /dev/virtio-ports/
```

`active` plus een lijst met `org.qemu.guest_agent.0` betekent dat het werkt. Is de service inactief
en bestaat dat pad niet, dan is de VM sinds het aanzetten van het vinkje niet uit en aan geweest.

Back-uppen met Proxmox Backup Server in snapshot-modus met de guest agent ingeschakeld, zodat
`fsfreeze` eerst draait.

### VMware ESXi / vSphere

| Instelling | Waarde |
|---|---|
| Compatibiliteit | Hardwareversie 19 of hoger |
| Gast-OS | `Debian GNU/Linux 12 (64-bit)` of `Ubuntu Linux (64-bit)` |
| Firmware | `EFI` (Secure Boot mag aan blijven) |
| SCSI-controller | **VMware Paravirtual (PVSCSI)** |
| Netwerkadapter | **VMXNET3** — nooit E1000/E1000E |
| Schijf | Thick provisioned, eager zeroed |
| Geheugen | **Reserveer al het gastgeheugen** |
| CPU-/geheugen-hot-add | **Uitgeschakeld** — geheugen-hot-add schakelt vNUMA uit |

```bash
sudo apt-get install -y open-vm-tools
```

Gebruik quiesced snapshots als je er maakt, en verwijder ze snel — een blijvende snapshot verslechtert
de schrijfprestaties elke dag dat hij bestaat.

### Microsoft Hyper-V

| Instelling | Waarde |
|---|---|
| Generatie | **2** |
| Secure Boot | Aan, sjabloon **"Microsoft UEFI Certificate Authority"** |
| Dynamic Memory | **Uitgeschakeld** — vaste toewijzing |
| Netwerkadapter | De standaard synthetische adapter, niet "Legacy" |
| VHDX | Vaste grootte, op SSD/NVMe |
| Automatic Stop Action | **Shut down**, niet "Save state" |
| Automatic Checkpoints | **Uitgeschakeld** |

Het standaard Windows Secure Boot-sjabloon start Linux niet op, en Dynamic Memory veroorzaakt de
meeste problemen: PostgreSQL vult geheugen bewust met zijn buffer cache, Hyper-V leest dat als druk,
en onder hostdruk belandt de working set van de database in swap.

```powershell
Set-VMFirmware -VMName "velnox" -SecureBootTemplate "MicrosoftUEFICertificateAuthority"
Set-VM -VMName "velnox" -AutomaticCheckpointsEnabled $false -AutomaticStopAction ShutDown
```

Haal de tijd uit het PTP-apparaat van de host in plaats van NTP te laten vechten met de
Hyper-V-tijdsynchronisatie:

```bash
sudo apt-get install -y chrony && echo 'refclock PHC /dev/ptp_hyperv poll 3 dpoll -2 offset 0' | sudo tee /etc/chrony/conf.d/hyperv.conf && sudo systemctl restart chrony
```

---

## Installeren

Op een verse Debian 12/13- of Ubuntu 22.04/24.04-server, als gebruiker met `sudo`:

```bash
sudo apt-get update && sudo apt-get install -y git && sudo git clone https://github.com/DaanBusman/Velnox.git /opt/velnox && sudo bash /opt/velnox/install.sh
```

De installer stelt twee vragen — het adres dat operators gaan gebruiken, en of je een zelfondertekend
of een publiek vertrouwd certificaat wilt — toont daarna zijn voortgang en drukt de URL af als hij
klaar is. Reken op vijf tot tien minuten, grotendeels het bouwen van de images.

Volledig onbewaakt:

```bash
sudo bash /opt/velnox/install.sh --non-interactive --site-address=velnox.example.internal
```

| Optie | Betekenis |
|---|---|
| `--non-interactive`, `-y` | Nooit vragen stellen; standaarden en vlaggen gebruiken |
| `--site-address=HOST` | Hostnaam of IP dat operators gebruiken. Standaard het IP van deze host |
| `--tls=internal\|EMAIL` | `internal` voor een zelfondertekend certificaat (standaard), of een e-mailadres om er een van Let's Encrypt te halen |
| `--http-port=POORT` | Hostpoort voor HTTP (standaard 80) |
| `--https-port=POORT` | Hostpoort voor HTTPS (standaard 443) |
| `--skip-docker` | Docker is al geïnstalleerd en ingericht |
| `--skip-verify` | De verificatie na installatie overslaan |

De installer opnieuw draaien is veilig. Hij overschrijft nooit een bestaande `.env` en raakt je data
niet aan, dus hij is meteen het upgradepad na een `git pull`.

> ### Maak een back-up van `MASTER_ENCRYPTION_KEY`
>
> De installer toont hem als hij klaar is. Elk credential dat Velnox opslaat is versleuteld met een
> sleutel die daarvan is afgeleid, en er is geen herstelpad als je hem kwijtraakt — dat is een
> ontwerpkeuze. Zet hem in je wachtwoordmanager voordat je iets anders doet.

---

## Beheren

Alle commando's draaien vanuit `/opt/velnox`.

Status en logs:

```bash
cd /opt/velnox && sudo docker compose -f deploy/compose/docker-compose.yml --env-file .env ps
```

```bash
cd /opt/velnox && sudo docker compose -f deploy/compose/docker-compose.yml --env-file .env logs -f api
```

Een draaiende installatie op elk moment opnieuw controleren:

```bash
cd /opt/velnox && bash scripts/verify-stack.sh https://velnox.example.internal
```

Stoppen (data blijft behouden in named volumes):

```bash
cd /opt/velnox && sudo docker compose -f deploy/compose/docker-compose.yml --env-file .env down
```

---

## Certificaten

Velnox serveert HTTPS via Caddy in een van drie modi. Je wijzigt dat op elk moment, op een draaiende
installatie, met `scripts/tls.sh`. Er wordt niets weggeschreven voordat het materiaal is
gevalideerd, dus een certificaat dat niet gewerkt zou hebben wordt geweigerd terwijl het werkende
nog steeds serveert.

```bash
cd /opt/velnox && sudo bash scripts/tls.sh --status
```

| Modus | Wat het is | Vernieuwing |
|---|---|---|
| `internal` | Een certificaat van de eigen CA van Caddy. Browsers waarschuwen eenmalig. De standaard van het installatieprogramma. | Automatisch |
| Let's Encrypt | Een publiek vertrouwd certificaat, verkregen via ACME. | Automatisch |
| Je eigen | Een certificaat dat je al hebt, van je eigen CA of een commerciële uitgever. | **Van jou** |

Dezelfde informatie staat in het product onder **Serverbeheer → Certificaat**, dat daarnaast toont
welk certificaat de proxy *daadwerkelijk* aanbiedt — gelezen uit een echte handshake en niet uit de
configuratie, zodat een wijziging die is weggeschreven maar nooit is opgepakt zichtbaar is in plaats
van als succes gemeld.

### Overstappen op Let's Encrypt

```bash
cd /opt/velnox && sudo bash scripts/tls.sh --letsencrypt=jij@example.com
```

Het adres is het contact van het ACME-account; een aparte optie is niet nodig. Hiervoor moet
`VELNOX_SITE_ADDRESS` een naam zijn die publiek resolvet en deze host bereikt op poort 80 en 443.
Let's Encrypt geeft geen certificaten uit voor IP-adressen, en het script weigert dat in plaats van
Caddy stilletjes te laten falen.

Uitgifte duurt tot een minuut. Caddy vernieuwt daarna zelf.

### Een certificaat installeren dat je al hebt

```bash
cd /opt/velnox && sudo bash scripts/tls.sh --certificate=/pad/naar/fullchain.pem --key=/pad/naar/privkey.pem
```

Beide bestanden moeten PEM zijn. Een versleutelde privésleutel moet je eerst ontsleutelen — Caddy
kan niet om een wachtwoordzin vragen. Heeft je uitgever het leaf-certificaat en de keten apart
geleverd, geef dan ook `--chain=` mee, of plak ze zelf achter elkaar; de meeste browsers weigeren
een leaf zonder zijn uitgevers.

Voordat er iets wordt weggeschreven controleert het script dat de sleutel bij het certificaat hoort,
dat het certificaat niet is verlopen, en dat een van de namen erop `VELNOX_SITE_ADDRESS` dekt. Een
naam die niet klopt levert een waarschuwing op en geen weigering, want vooruitlopen op een
DNS-wijziging is legitiem — maar browsers weigeren de verbinding tot de twee overeenkomen.

Het certificaat en de sleutel komen in `deploy/caddy/tls/`, de sleutel met modus 0600, en die map
wordt alleen-lezen in de Caddy-container gemount. **Vernieuwen is in deze modus jouw taak.** Velnox
waarschuwt op het certificaatscherm vanaf 30 dagen vooraf, en `scripts/verify-stack.sh` faalt zodra
het is verlopen.

### Terug naar een zelfondertekend certificaat

```bash
cd /opt/velnox && sudo bash scripts/tls.sh --self-signed
```

### Waarom dit geen knop in de interface is

Een certificaat installeren betekent een privésleutel naar schijf schrijven en de proxy herstarten.
Velnox doet geen van beide vanuit een HTTP-eindpunt: de API bewaart geen TLS-materiaal, voert geen
shellcommando's uit, en kan geen container herstarten. Dat in een webformulier stoppen zou betekenen
dat de API-container de proxy mag herconfigureren, en dat is een veel groter ding om te hebben dan
het gemak waard is. Op de host hoort het thuis, onder hetzelfde vertrouwensmodel als het
installatieprogramma.

Elke wijziging herstart Caddy, wat ongeveer een seconde downtime op de console kost. Verder wordt er
niets onderbroken: de worker houdt geen verbinding via Caddy.

---

## Bijwerken

Drie stappen, in deze volgorde. Stap 1 is de stap die je geneigd bent over te slaan, en het is de stap
die de andere twee terugdraaibaar maakt.

### Stap 1 — Back-up de database. Eerst.

```bash
cd /opt/velnox && sudo sh -c 'docker compose -f deploy/compose/docker-compose.yml --env-file .env exec -T postgres pg_dump -U velnox -d velnox --format=custom > "/var/backups/velnox-$(date +%F).dump"'
```

De `sudo sh -c` eromheen is geen opsmuk, en geen van beide helften is optioneel. Rechtstreeks omleiden — `sudo commando > /var/backups/bestand` — mislukt, omdat uw shell het bestand opent voordat sudo draait, als uzelf. Het opsplitsen in twee sudo's met een pipe ertussen mislukt op een andere manier: beide helften starten tegelijk, geen van beide heeft een gecachete aanmelding, en allebei vragen ze om een wachtwoord op dezelfde terminal. Eén sudo om het geheel vraagt één keer en doet de omleiding als root.

Dit kost seconden, en het is de enige weg terug. **Migraties lopen alleen vooruit.** Voegt de nieuwe
versie er een toe en wil je daarna weer de vorige versie, dan kan de oudere code niet tegen het
nieuwere schema — een `git checkout` alleen draait dat niet terug. Zonder deze dump zit je vast aan
vooruit.

### Stap 2 — Bekijk wat je gaat krijgen

```bash
cd /opt/velnox && sudo git fetch && sudo git log --oneline HEAD..origin/main
```

Overslaan mag, maar het kost een seconde en laat zien of je één kleine fix ophaalt of een maand aan
wijzigingen.

### Stap 3 — Bijwerken

```bash
cd /opt/velnox && sudo git pull && sudo bash install.sh --non-interactive
```

Dat is de hele procedure. De installer bouwt de images opnieuw, voert nieuwe migraties uit, herstart
de services en verifieert het resultaat — dezelfde stappen als bij een eerste installatie, en daarom
is er geen apart upgradescript dat achterop kan raken.

Weigert `git pull` vanwege lokale wijzigingen, dan heb je iets in `/opt/velnox` aangepast. Bewaar het
met `git stash`, of gooi het weg met `git checkout -- <bestand>`. Configuratie hoort in `.env`, die
git negeert, dus een conflict hier betekent meestal een aanpassing die eigenlijk een echte wijziging
in de repository zou moeten worden.

**Wat de upgrade behoudt.** Je `.env` wordt nooit opnieuw gegenereerd, dus secrets blijven staan. Het
site-adres, de TLS-modus en de poorten worden uit je bestaande configuratie gelezen in plaats van
opnieuw afgeleid, zodat een onbewaakte upgrade een hostnaam niet stilletjes terugzet naar een
IP-adres of een publiek vertrouwd certificaat vervangt door een zelfondertekend. Named volumes worden
niet aangeraakt, dus de database en de wachtrij blijven intact.

**Wat wél ververst wordt.** De build-commit, die de bronlink onder Instellingen → Over toont. Dat is
buildinformatie en geen configuratie, dus die volgt altijd de code die werkelijk draait.

### Wat je kunt verwachten

Vijf tot tien minuten, grotendeels het opnieuw bouwen van de images. Aan het eind herstarten de
services, dus er is een korte onderbreking — ruwweg een minuut — terwijl de containers opnieuw worden
aangemaakt. De installer keert pas terug als elke health check slaagt; komt het commando succesvol
terug, dan is de upgrade geslaagd.

Ruim daarna de build cache op, anders groeit die eindeloos:

```bash
sudo docker builder prune -f
```

### Als een upgrade misgaat

De installer stopt bij de mislukte stap en toont de laatste regels van zijn log; het volledige log
staat in `/var/log/velnox-install-*.log`. Er blijft op compose-niveau niets half toegepast achter:
migraties draaien in een eenmalige container die moet slagen voordat de API start.

Terug naar de vorige versie:

```bash
cd /opt/velnox && sudo git log --oneline -5
```

```bash
cd /opt/velnox && sudo git checkout <vorige-commit> && sudo bash install.sh --non-interactive
```

Dat volstaat **alleen als de upgrade geen migratie toevoegde**. Deed hij dat wel, zet dan eerst je
dump uit stap 1 terug en check daarna pas de oudere commit uit:

```bash
cd /opt/velnox && sudo sh -c 'docker compose -f deploy/compose/docker-compose.yml --env-file .env exec -T postgres pg_restore -U velnox -d velnox --clean --if-exists < /var/backups/velnox-2026-09-01.dump'
```

### Meerdere machines gelijk houden

De commit onder Instellingen → Over is de exacte broncode van de draaiende build, dus die naast elkaar
leggen laat zien welke installaties achterlopen. Voor een groep hosts draai je op elke machine
dezelfde drie stappen; de installer is idempotent, dus hem draaien op een machine die al actueel is
doet geen kwaad en kost ongeveer een minuut.

---

### De schijf van de ISO-bibliotheek

ISO's en cloud images staan in een eigen Docker-volume, `velnox_library`. Een named volume heeft geen
quotum, dus Velnox handhaaft zelf twee grenzen, ingesteld in `.env`:

| Instelling | Standaard | Betekenis |
|---|---|---|
| `VELNOX_LIBRARY_MAX_GB` | 100 | Het meeste dat de bibliotheek mag bevatten, inclusief overdrachten die nog lopen. |
| `VELNOX_LIBRARY_MIN_FREE_GB` | 10 | Vrije schijfruimte die na een overdracht over moet blijven. |

De grens die het eerst wordt bereikt weigert de overdracht, en de weigering noemt de grens en de
getallen. De ondergrens is belangrijker dan het plafond: het volume staat op dezelfde schijf als
PostgreSQL tenzij je het verplaatst, en een volle schijf legt de hele installatie stil, niet alleen de
upload. Op de evaluatiegrootte van 40 GB loop je eerst tegen de ondergrens aan, en daar is hij voor.

Verander een van beide waarden en voer dan
`sudo docker compose -f deploy/compose/docker-compose.yml --env-file .env up -d` uit, zodat de API en de
worker hem lezen. Het plafond verlagen tot onder wat de bibliotheek al bevat verwijdert niets; het
weigert alleen nieuwe bestanden tot er genoeg zijn verwijderd.

Wil je de bibliotheek een eigen schijf geven, koppel die dan vóór de eerste start op de plek van het
volume, of verplaats de inhoud van het volume daarheen terwijl de stack gestopt is. Velnox meet de
vrije ruimte op het bestandssysteem waar de bibliotheek op staat.

### Back-up

Twee dingen, en één daarvan zit niet in de database:

```bash
sudo sh -c 'docker compose -f deploy/compose/docker-compose.yml --env-file .env exec -T postgres pg_dump -U velnox -d velnox --format=custom > "/var/backups/velnox-$(date +%F).dump"'
```

…en `/opt/velnox/.env`, waar `MASTER_ENCRYPTION_KEY` in staat. Een databaseback-up zonder die sleutel
is ciphertext die je nooit meer kunt lezen.

Herstel door `.env` terug te zetten, de stack te starten zodat de migraties het schema aanmaken, en
dan:

```bash
sudo sh -c 'docker compose -f deploy/compose/docker-compose.yml --env-file .env exec -T postgres pg_restore -U velnox -d velnox --clean --if-exists < /var/backups/velnox-2026-09-01.dump'
```

Test het herstel voordat je erop vertrouwt.

**De ISO-bibliotheek zit niet in die back-up,** en hoeft dat meestal ook niet: elk bestand erin kwam
ergens vandaan en kan opnieuw worden opgehaald of geüpload. Wat de bibliotheek bevat staat in de
database, dus een herstelde database zonder het volume toont bestanden die er niet zijn; de worker
merkt dat binnen een kwartier en zet ze op *Mislukt*, met als reden dat het bestand weg is, en ze
verwijderen op het scherm **ISO-bibliotheek** ruimt ze op. Is opnieuw ophalen voor jou duur, back-up
het volume dan ook:

```bash
sudo docker run --rm -v velnox_library:/library:ro -v /var/backups:/backup alpine tar -C /library -cf /backup/velnox-library.tar .
```

### Oude back-ups verwijderen

Elke dump is een nieuw bestand, en niets ruimt ze voor je op. `scripts/prune-backups.sh` doet dat
wel. Draai het eerst zonder `--delete`: het toont wat het zou verwijderen en raakt niets aan.

```bash
cd /opt/velnox && sudo bash scripts/prune-backups.sh
```

Als de lijst klopt met wat je verwacht, verwijder ze dan:

```bash
cd /opt/velnox && sudo bash scripts/prune-backups.sh --delete
```

Standaard verwijdert het dumps ouder dan 30 dagen en houdt het altijd de 7 nieuwste, hoe oud die ook
zijn. Beide zijn aan te passen, net als de map:

```bash
cd /opt/velnox && sudo bash scripts/prune-backups.sh --older-than=90 --keep=14 --dir=/var/backups --delete
```

Wat het wel en niet doet:

- **Het kijkt alleen naar bestanden die precies `velnox-JJJJ-MM-DD.dump` heten** — de naam die de
  commando's hierboven maken. Al het andere in de map, en elke symlink, blijft staan.
- **De leeftijd van een dump is de datum in de naam, niet de wijzigingstijd van het bestand.** Een
  back-up die je terugkopieert van externe opslag krijgt een nieuwe wijzigingstijd; daarop afgaand zou
  hij nooit oud lijken.
- **De nieuwste back-up wordt nooit verwijderd.** `--keep` moet minstens 1 zijn, en een bestand
  waarvan de naam geen echte datum is (`velnox-2026-02-31.dump`) blijft staan en telt daar niet voor
  mee.
- **Het laat `.env`-back-ups met rust.** `scripts/gen-env.sh --force` schrijft een nieuwe `.env` met
  een nieuwe `MASTER_ENCRYPTION_KEY`, en bewaart het oude bestand als `.env.<tijdstempel>.bak`. Elke
  dump van vóór dat moment heeft de oude sleutel nodig om gelezen te worden, dus een `.bak`-bestand kan
  pas weg als geen dump die je bewaart ouder is. Dat is een afweging die het script niet voor je kan
  maken.

Het script heeft eigen tests, die GNU-tools nodig hebben en dus op de host of in een container draaien:

```bash
cd /opt/velnox && bash scripts/test-prune-backups.sh
```

---

## Schijfruimte vrijmaken

Eerst kijken, dan opruimen — in deze volgorde, veiligste eerst. Niets in deze sectie raakt de
database.

### Waar de ruimte heen ging

```bash
df -h /
```

```bash
sudo docker system df
```

```bash
sudo sh -c 'du -sh /var/lib/docker/containers/* 2>/dev/null | sort -h | tail -5'
```

```bash
ls -lh /var/backups/velnox-*.dump
```

```bash
sudo du -sh /var/lib/docker/volumes/velnox_library
```

De derde toont de containerlogs, één map per container, grootste als laatste. Sinds 0.5.5 bewaart
elke container hooguit vijf bestanden van 10 MB — ongeveer 50 MB, of 350 MB voor de hele stack — en
valt de oudste weg zodra er een nieuwe begint. Vóór 0.5.5 was er helemaal geen limiet, en op een host
die maanden draaide konden ze gigabytes groot worden.

### Opruimen

**De Docker build cache** is meestal het grootst, en altijd veilig om te verwijderen. De volgende
upgrade bouwt iets langzamer.

```bash
sudo docker builder prune -af
```

**Images die eerdere upgrades achterlieten.** Elke upgrade verplaatst de `velnox-*:local`-tags naar
nieuwe images en laat de oude zonder tag achter. Dit verwijdert alleen images zonder tag; die van de
draaiende stack blijven staan.

```bash
sudo docker image prune -f
```

**Containerlogs van vóór 0.5.5.** Bijwerken ruimt ze vanzelf op: de wijziging die ze begrenst laat de
volgende `docker compose up -d` elke container opnieuw aanmaken, en de logs van een container gaan
mee. Die eerste upgrade herstart daardoor ook PostgreSQL — een paar seconden zonder console, en geen
gegevens kwijt, want de database staat in een volume en niet in de container.

Kun je nog niet bijwerken, maak ze dan leeg. De loggeschiedenis is weg, en daarmee ook voor het
oplossen van problemen, dus lees eerst wat je nodig hebt.

```bash
sudo sh -c 'truncate -s 0 /var/lib/docker/containers/*/*-json.log'
```

**Systeemlogs en de pakketcache:**

```bash
sudo journalctl --vacuum-size=200M
```

```bash
sudo apt-get clean
```

**Oude databaseback-ups** — zie [Oude back-ups verwijderen](#oude-back-ups-verwijderen).

**Bestanden in de ISO-bibliotheek** — verwijder ze op het scherm **ISO-bibliotheek**, niet op de host.
Het scherm verwijdert het bestand en de registratie samen; met de hand verwijderen onder
`/var/lib/docker/volumes/velnox_library` laat registraties achter die nergens naar wijzen, en een
bestand waarvan de registratie weg is, wordt door de worker toch verwijderd.

### Nooit

Deze lijken op hetzelfde soort opruimen, en zijn het niet. Ze verwijderen Docker-volumes, en `pgdata`
is een volume: de hele database gaat mee — en de ISO-bibliotheek ook, want dat is ook een volume. Hetzelfde geldt voor het met de hand verwijderen van iets
onder `/var/lib/docker/volumes`.

```
docker system prune --volumes
docker volume prune
```

---

## Als er iets misgaat

De installer schrijft een volledig log naar `/var/log/velnox-install-*.log` en toont bij een fout de
laatste regels daarvan.

| Verschijnsel | Oorzaak |
|---|---|
| Poort 80 of 443 al in gebruik | Er staat een andere webserver op. Verwijder die, of geef `--http-port` / `--https-port` mee |
| `apt-get update` vindt geen `Release`-bestand voor Docker | Docker heeft nog geen pakketten voor jouw releasecodenaam. Vervang de codenaam in `/etc/apt/sources.list.d/docker.list` door de vorige stabiele |
| De browser waarschuwt over het certificaat | Verwacht bij een zelfondertekend certificaat. Accepteer het, verspreid de root-CA van Caddy uit `sudo docker compose ... exec caddy cat /data/caddy/pki/authorities/local/root.crt`, of draai opnieuw met `--tls=jij@example.com` en een publieke hostnaam |
| `readyz` meldt de worker als verminderd | Dat gebeurt boven 45 seconden zonder hartslag. Kijk in `sudo docker compose ... logs worker` |
| Schijf loopt vol | Meestal de Docker build cache of containerlogs. Zie [Schijfruimte vrijmaken](#schijfruimte-vrijmaken) |

---

## Beveiliging

De API en de UI worden op één origin achter Caddy geserveerd, met HSTS, CSP en de gebruikelijke
hardening headers. PostgreSQL en Redis zijn van buitenaf onbereikbaar. Alleen de worker-container
heeft een netwerkroute naar de infrastructuur die Velnox beheert.

**Deze build kent nog geen authenticatie** — elke pagina en elk endpoint staat open. Rol hem uit op
een beheernetwerk achter een firewall, en nergens waar onvertrouwde mensen bij kunnen.

---

*De naam en het logo van Velnox worden gebruikt door The Velnox Foundation. Er is geen merk geregistreerd of geclaimd; de AGPLv3 verleent daar geen rechten op. Velnox is vrije software onder de AGPLv3.*

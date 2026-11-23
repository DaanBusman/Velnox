# Velnox — Uitrolhandleiding

> **Vertaling.** Bron: [docs/deployment.md](../deployment.md) @ `366d091`.
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
| Evaluatie | 2 | 3 GB | 25 GB |
| Tot ~10 clusters / ~50 nodes | 2 | 4 GB | 40 GB |
| Tot ~50 clusters / ~300 nodes | 4 | 6 GB | 80 GB |

Debian 12 of 13, of Ubuntu 22.04 of 24.04 LTS. Uitsluitend 64-bits x86. Een minimale
serverinstallatie, met verder niets dat op poort 80 en 443 luistert.

**Waar deze getallen op rusten** (gemeten op 0.7.8). Draaiend is Velnox klein: de zes services samen
gebruiken in rust zo'n 350 MB, en op hun piek 390 MB met 50 clusters van drie nodes die *elke minuut*
worden uitgelezen — dertig keer de standaard — met de worker op hooguit een vijfde van één core. Wat
de ondergrens bepaalt is het bouwen van de images, wat de installer bij elke installatie en upgrade op
de host doet: dat vraagt een paar minuten lang zo'n 2 GB geheugen, en mislukt onder de 1,75 GB. Het
geheugen hierboven is dat, plus het besturingssysteem en Docker, plus de stack die tijdens een upgrade
naast de build blijft draaien — met ruimte voor de cache van PostgreSQL om mee te groeien met de
historie. De nagebootste clusters zijn klein en antwoorden direct; echte clusters met honderden gasten
maken elke uitlezing zwaarder, en daarvoor is de marge in de grotere rijen.

Schijf: het besturingssysteem, zo'n 3 GB aan images, en minder dan 1 GB pakketcache die tussen builds
bewaard blijft. Een upgrade heeft terwijl hij loopt zo'n 8 GB extra nodig — de nieuwe images en hun
build cache — en de installer verwijdert zowel die build cache als de images die vervangen zijn zodra
de nieuwe stack gezond is. Wat daarna groeit zijn auditrecords, joblogs en historie, je databaseback-ups,
en de ISO-bibliotheek, meestal de grootste van allemaal: de schijf hierboven laat ruimte voor een paar
ISO's, niet voor een bibliotheek. Zie [De schijf van de ISO-bibliotheek](#de-schijf-van-de-iso-bibliotheek).

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
| Guest agent | Ingeschakeld — en installeer hem ook in de gast |
| Starten bij opstarten | Ja |

```bash
sudo apt-get install -y qemu-guest-agent
```

Installeren is alles wat je in de gast doet. Voer `systemctl enable qemu-guest-agent` **niet** uit:
de unit wordt door udev gestart zodra de virtuele seriële poort verschijnt, en hem inschakelen levert
een lap tekst op over een unit zonder installatieconfiguratie — dat is systemd die correct meldt dat
het commando zinloos was, geen fout die je moet verhelpen.

Wat wél telt is het vinkje **Guest agent** in de VM-opties hierboven. Dat toevoegen is een
hardwarewijziging, dus een draaiende VM moet volledig worden gestopt en gestart — opnieuw opstarten
vanuit de gast is niet genoeg. Controleren of het gelukt is:

```bash
systemctl is-active qemu-guest-agent && ls /dev/virtio-ports/
```

`active` plus een lijst met `org.qemu.guest_agent.0` betekent dat het werkt. Is de service inactief
en bestaat dat pad niet, dan is de VM sinds het aanzetten van het vinkje niet uit en aan geweest.

Maak back-ups met Proxmox Backup Server in snapshotmodus met de guest agent ingeschakeld, zodat
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
niet aan. Daarom gebruikt `sudo velnox update` hem voor upgrades.

> ### Maak een back-up van `MASTER_ENCRYPTION_KEY`
>
> De installer toont hem als hij klaar is. Elke credential die Velnox opslaat is versleuteld met een
> sleutel die daarvan is afgeleid, en er is geen herstelpad als je hem kwijtraakt — dat is een
> ontwerpkeuze. Zet hem in je wachtwoordmanager voordat je iets anders doet.

---

## Beheren

De installer voegt één commando toe voor alles hieronder. Het werkt vanuit elke map.

| Commando | Wat het doet |
|---|---|
| `sudo velnox status` | Toont wat er draait |
| `sudo velnox logs [service]` | Volgt de logs van `api`, `worker`, `web`, `caddy`, `postgres` of `redis`, of van allemaal |
| `sudo velnox check` | Controleert de draaiende installatie |
| `sudo velnox start` / `stop` | Start of stopt Velnox. Bij stoppen blijft alle data bewaard |
| `sudo velnox restart [service]` | Herstart één service of allemaal |
| `sudo velnox update` | Maakt een back-up van de database en upgradet daarna |
| `sudo velnox update --check` | Toont wat een upgrade zou brengen en verandert niets |
| `sudo velnox rollback [commit]` | Toont recente versies, of gaat terug naar een daarvan |
| `sudo velnox backup` | Maakt een back-up van de database in `/var/backups` |
| `sudo velnox backup list` | Toont de back-ups |
| `sudo velnox backup prune` | Toont welke oude back-ups weg kunnen. Voeg `--delete` toe om ze te verwijderen |
| `sudo velnox backup restore <bestand>` | Zet een back-up terug |
| `sudo velnox backup library` | Maakt ook een back-up van de ISO-bibliotheek |
| `sudo velnox cert status` | Toont het certificaat dat wordt geserveerd |
| `sudo velnox cert self-signed` | Gebruikt het eigen certificaat van Caddy |
| `sudo velnox cert letsencrypt <e-mail>` | Gebruikt Let's Encrypt |
| `sudo velnox cert install <cert> <sleutel> [keten]` | Gebruikt een certificaat dat je al hebt |
| `sudo velnox disk` | Toont waar de schijfruimte heen ging |
| `sudo velnox clean` | Ruimt caches op. Raakt je data nooit aan |
| `velnox version`, `velnox help` | De geïnstalleerde versie, en deze lijst |

Geïnstalleerd vóór 0.7.37? Het commando komt mee met je volgende upgrade, die eenmalig zo gaat:

```bash
cd /opt/velnox && sudo git pull --ff-only && sudo bash scripts/velnox.sh update
```

---

## Certificaten

Velnox serveert HTTPS via Caddy in een van drie modi. Je wijzigt dat op elk moment, op een draaiende
installatie: in het product onder **Serverbeheer → Certificaat**, of op de host met
`velnox cert`. Hoe dan ook wordt er niets geserveerd voordat het is gevalideerd, dus een
certificaat dat niet gewerkt zou hebben wordt geweigerd terwijl het werkende nog steeds serveert.

```bash
sudo velnox cert status
```

| Modus | Wat het is | Vernieuwing |
|---|---|---|
| `internal` | Een certificaat van de eigen CA van Caddy. Browsers waarschuwen eenmalig, en installeren Velnox pas als app als de werkplek die CA vertrouwt ([hoe](installing-as-an-app.md#als-installeren-als-app-er-niet-staat)). De standaard van het installatieprogramma. | Automatisch |
| Let's Encrypt | Een publiek vertrouwd certificaat, verkregen via ACME. | Automatisch |
| Je eigen | Een certificaat dat je al hebt, van je eigen CA of een commerciële uitgever. | **Van jou** |

**Serverbeheer → Certificaat** toont ook welk certificaat de proxy *daadwerkelijk* aanbiedt —
gelezen uit een echte handshake en niet uit de configuratie, zodat een wijziging die is
weggeschreven maar nooit is opgepakt zichtbaar is in plaats van als succes gemeld.

### Wijzigen in de interface

**Serverbeheer → Certificaat → Het certificaat wijzigen**, met `system.manage`:

- **Zoals geïnstalleerd** — wat de installatie instelde uit `VELNOX_TLS`, en wat `velnox cert`
  wijzigt.
- **Zelfondertekend** — de eigen certificaatautoriteit van Caddy.
- **Let's Encrypt** — met een accountadres; vernieuwd door Caddy. **Een andere ACME-autoriteit
  gebruiken** noemt een andere directory — een eigen CA zoals step-ca, of een testserver — met de
  root die haar HTTPS ondertekent als die niet publiek vertrouwd is.
- **Mijn eigen certificaat** — plak het certificaat met zijn keten, en de onversleutelde
  privésleutel, of lees ze uit een PEM-bestand met de knop onder het veld. Een PFX-bestand (`.pfx`
  of `.p12`) bevat ze allebei: kies het met de certificaatknop en vul het wachtwoord in, als het er
  een heeft. Velnox zet het op de server om, gebruikt het wachtwoord eenmalig en bewaart het
  wachtwoord noch het bestand. Dezelfde controles als het script: de sleutel moet bij het certificaat horen, en het
  mag niet verlopen zijn; namen die het adres niet dekken, of een ontbrekende keten, zijn
  waarschuwingen. De sleutel wordt versleuteld in de geheimenopslag van Velnox bewaard en wordt
  nooit meer getoond.

**Toepassen** schrijft de configuratie en vraagt Caddy via zijn admin-socket die te laden. Caddy
weigert een configuratie die hij niet kan serveren en houdt het huidige certificaat; anders leest
het paneel het nu geserveerde certificaat terug en zegt of het het gekozen certificaat is. Let's
Encrypt kan een minuut duren: *nog niet geserveerd* betekent dan precies dat. De keuze overleeft
herstarts en upgrades: ze staat in de database, en de API schrijft de bestanden van Caddy bij elke
start opnieuw. Elke wijziging staat in het auditlog als `system.tls_changed`, nooit met de sleutel.

**Als de interface niet bereikbaar is** — na een certificaat dat browsers weigeren, bijvoorbeeld —
geeft elk `velnox cert`-commando dat het certificaat wijzigt de keuze terug aan die van de
installatie: het wist de keuze in de database, verwijdert de opgeslagen sleutel, legt dat vast in het
auditlog, en herstart de API en Caddy. `velnox cert status` zegt het als er een keuze uit de
interface wordt geserveerd.

### Overstappen op Let's Encrypt

```bash
sudo velnox cert letsencrypt jij@example.com
```

Het adres is het contact van het ACME-account. Hiervoor moet
`VELNOX_SITE_ADDRESS` een naam zijn die via openbare DNS te vinden is en naar deze host wijst, bereikbaar op poort 80 en 443.
Let's Encrypt geeft geen certificaten uit voor IP-adressen, en het commando weigert dat in plaats van
Caddy stilletjes te laten falen.

Uitgifte duurt tot een minuut. Caddy vernieuwt daarna zelf.

### Een certificaat installeren dat je al hebt

```bash
sudo velnox cert install /pad/naar/fullchain.pem /pad/naar/privkey.pem
```

Beide bestanden moeten PEM zijn. Een versleutelde privésleutel moet je eerst ontsleutelen — Caddy
kan niet om een wachtwoordzin vragen. Heeft je uitgever het leaf-certificaat en de keten apart
geleverd, noem de keten dan als derde bestand, of plak ze zelf achter elkaar; de meeste browsers
weigeren een leaf zonder zijn uitgevers.

Voordat er iets wordt weggeschreven controleert het commando dat de sleutel bij het certificaat hoort,
dat het certificaat niet is verlopen, en dat een van de namen erop `VELNOX_SITE_ADDRESS` dekt. Een
naam die niet klopt levert een waarschuwing op en geen weigering, want vooruitlopen op een
DNS-wijziging is legitiem — maar browsers weigeren de verbinding tot de twee overeenkomen.

Het certificaat en de sleutel komen in `deploy/caddy/tls/`, de sleutel met modus 0600, en die map
wordt alleen-lezen in de Caddy-container gemount. **Vernieuwen is in deze modus jouw taak.** Velnox
waarschuwt op het certificaatscherm vanaf 30 dagen vooraf, en `velnox check` faalt zodra
het is verlopen.

### Terug naar een zelfondertekend certificaat

```bash
sudo velnox cert self-signed
```

### Wat wijzigen in de interface kost

Tot fase 5C was dit bewust alleen een taak op de host: de API bewaarde geen TLS-materiaal en kon de
proxy niet herconfigureren. De eigenaar koos ervoor het in de interface te hebben, en ADR-045 legt
de prijs vast. De API-container schrijft nu een privésleutel voor Caddy en kan Caddy herladen via zijn
admin-API. Die API luistert op een Unix-socket in een volume dat alleen Caddy en de API koppelen —
geen poort, op geen enkel netwerk — en de API voert nog steeds geen shellcommando's uit en kan geen
container herstarten. Wie code kan uitvoeren in de API-container, kan het certificaat wijzigen; dat
was al genoeg om de database te lezen.

Een wijziging vanuit de interface herlaadt Caddy zonder herstart. Een wijziging met
`velnox cert` herstart de API en Caddy, wat een paar seconden op de console kost. Verder wordt er
niets onderbroken: de worker houdt geen verbinding via Caddy.

---

## Bijwerken

### Weten dat er een nieuwere versie is

Elk kwartier leest de worker één bestand, `release.json` op de main-branch van de repository: de
nieuwste versie en de advisories, de oplossingen die een installatie snel moet krijgen. Is
die versie nieuwer dan de draaiende, dan toont de zijbalk boven Serverbeheer **Velnox 0.7.x
beschikbaar** aan iedereen met `system.manage`, of **Kritieke update: Velnox 0.7.x** in rood als een
advisory die deze installatie raakt kritiek is. Dat opent **Serverbeheer → Updates**, met die advisories en de
procedure hieronder.

- **Wat er wordt verstuurd:** het verzoek om dat bestand, en verder niets — geen versie, geen
  instance-id, geen aantallen. GitHub ziet het adres waar het vandaan komt, zoals bij elke download.
- **Geen internet:** het paneel zegt *Kon niet controleren* en waarom, nooit *Up-to-date*; de zijbalk
  toont niets. Een mislukte poging wacht net als een geslaagde een kwartier.
- **Uitzetten:** *Controle uitzetten* in Serverbeheer → Updates (in het auditlog als
  `system.update_check_changed`). *Nu controleren* werkt ook als hij uitstaat.
- **Een ander adres:** `VELNOX_UPDATE_MANIFEST_URL` in `.env` noemt een ander https-adres — een
  mirror binnen het beheernetwerk, of het eigen bestand van een fork. Het wordt direct gelezen, niet
  via een proxy.

### Bijwerken in één commando

```bash
sudo velnox update
```

Dat is de hele procedure. Het maakt een back-up van de database, haalt de nieuwe versie op, bouwt de
images opnieuw, voert nieuwe migraties uit, herstart de services en verifieert het resultaat. Mislukt
de back-up, dan gebeurt er verder niets.

Om eerst te zien of je één kleine fix ophaalt of een maand aan wijzigingen:

```bash
sudo velnox update --check
```

**Waarom de back-up eerst komt.** Migraties lopen alleen vooruit. Voegt de nieuwe versie er een toe en
wil je daarna weer de vorige versie, dan kan de oudere code niet tegen het nieuwere schema. De back-up
is de enige weg terug, dus kopieer hem, samen met `.env`, naar een plek buiten deze machine.

Weigert de update vanwege lokale wijzigingen, dan heb je iets in `/opt/velnox` aangepast. Bewaar het
met `git stash`, of gooi het weg met `git checkout -- <bestand>`. Configuratie hoort in `.env`, die
git negeert, dus een conflict hier betekent meestal een aanpassing die eigenlijk een echte wijziging
in de repository zou moeten worden.

**Wat de upgrade behoudt.** Je `.env` wordt nooit opnieuw gegenereerd, dus secrets blijven staan. Het
site-adres, de TLS-modus en de poorten worden uit je bestaande configuratie gelezen in plaats van
opnieuw afgeleid, zodat een onbewaakte upgrade een hostnaam niet stilletjes terugzet naar een
IP-adres of een publiek vertrouwd certificaat vervangt door een zelfondertekend. Named volumes worden
niet aangeraakt, dus de database en de wachtrij blijven intact.

**Wat wél ververst wordt.** De build-commit, die de bronlink onder **Broncode → Over** toont. Dat is
buildinformatie en geen configuratie, dus die volgt altijd de code die werkelijk draait.
En de software eronder: de Node.js-basisimage van Velnox' eigen images, en de images van PostgreSQL,
Redis en Caddy, elk opnieuw opgehaald op de nieuwste release van de major waarop ze vastliggen
(`postgres:16`, `redis:7`, `caddy:2`). Een upgrade is dus ook de manier waarop hun securityfixes
binnenkomen — af en toe draaien loont, ook als Velnox zelf niet veranderd is. Een nieuwe major van een
van de drie wordt nooit vanzelf genomen: die van PostgreSQL verandert bovendien het dataformaat en
vraagt om een dump en restore.

### Wat je kunt verwachten

Vijf tot tien minuten, grotendeels het opnieuw bouwen van de images. Aan het eind herstarten de
services, dus er is een korte onderbreking — ruwweg een minuut — terwijl de containers opnieuw worden
aangemaakt. De installer keert pas terug als elke health check slaagt; komt het commando succesvol
terug, dan is de upgrade geslaagd.

Daarna verwijdert de installer de build cache — op de pakketdownloads na, die de volgende upgrade kan
hergebruiken — en de images die de upgrade verving. Geen van beide groeit van upgrade tot upgrade.

### Als een upgrade misgaat

De installer stopt bij de mislukte stap en toont de laatste regels van zijn log; het volledige log
staat in `/var/log/velnox-install-*.log`. Er blijft op compose-niveau niets half toegepast achter:
migraties draaien in een eenmalige container die moet slagen voordat de API start.

Om terug te gaan, toon je de recente versies:

```bash
sudo velnox rollback
```

Noem daarna de versie die je wilt:

```bash
sudo velnox rollback <vorige-commit>
```

Voegde de upgrade een migratie toe, dan weigert het commando, omdat de oudere code niet op de nieuwere
database kan draaien. Noem dan ook de back-up van vóór de upgrade:

```bash
sudo velnox rollback <vorige-commit> --restore=/var/backups/velnox-2026-09-01.dump
```

Het vraagt om bevestiging en bewaart eerst de huidige database. Mislukt het terugzetten, dan blijft de
database zoals hij was en wordt er niets teruggedraaid.

### Meerdere machines gelijk houden

De commit onder **Broncode → Over** is de exacte broncode van de draaiende build, dus die naast elkaar
leggen laat zien welke installaties achterlopen. Voor een groep hosts draai je op elke machine
`sudo velnox update`; dat op een machine draaien die al actueel is doet geen kwaad en kost ongeveer
een minuut.

---

### De schijf van de ISO-bibliotheek

ISO's en cloud-images staan in een eigen Docker-volume, `velnox_library`. Een named volume heeft geen
quotum, dus Velnox handhaaft zelf twee grenzen, ingesteld in `.env`:

| Instelling | Standaard | Betekenis |
|---|---|---|
| `VELNOX_LIBRARY_MAX_GB` | 100 | Het meeste dat de bibliotheek mag bevatten, inclusief overdrachten die nog lopen. |
| `VELNOX_LIBRARY_MIN_FREE_GB` | 10 | Vrije schijfruimte die na een overdracht over moet blijven. |

De grens die het eerst wordt bereikt weigert de overdracht, en de weigering noemt de grens en de
getallen. De ondergrens is belangrijker dan het plafond: het volume staat op dezelfde schijf als
PostgreSQL tenzij je het verplaatst, en een volle schijf legt de hele installatie stil, niet alleen de
upload. Op de evaluatiegrootte van 25 GB loop je eerst tegen de ondergrens aan, en daar is hij voor.

Verander een van beide waarden en voer dan `sudo velnox start` uit, zodat de API en de worker hem
lezen. Het plafond verlagen tot onder wat de bibliotheek al bevat verwijdert niets; het
weigert alleen nieuwe bestanden tot er genoeg zijn verwijderd.

Wil je de bibliotheek een eigen schijf geven, koppel die dan vóór de eerste start op de plek van het
volume, of verplaats de inhoud van het volume daarheen terwijl de stack gestopt is. Velnox meet de
vrije ruimte op het bestandssysteem waar de bibliotheek op staat.

### Back-up

Twee dingen, en één daarvan zit niet in de database:

```bash
sudo velnox backup
```

…en `/opt/velnox/.env`, waar `MASTER_ENCRYPTION_KEY` in staat. Een databaseback-up zonder die sleutel
is ciphertext die je nooit meer kunt lezen.

Een back-up is alleen door root leesbaar en vervangt nooit een eerdere: een tweede back-up op dezelfde
dag krijgt de tijd in zijn naam.

Herstel door `.env` terug te zetten, Velnox te starten met `sudo velnox start` zodat de migraties het
schema aanmaken, en dan:

```bash
sudo velnox backup restore /var/backups/velnox-2026-09-01.dump
```

Het vraagt om bevestiging, bewaart eerst de huidige database en stopt de services die hem gebruiken.
Het terugzetten is één transactie, dus als het mislukt blijft de database zoals hij was. Daarna voert
het de migraties van de geïnstalleerde versie uit en start het de services die draaiden.

Test het herstel voordat je erop vertrouwt.

**De ISO-bibliotheek zit niet in die back-up,** en hoeft dat meestal ook niet: elk bestand erin kwam
ergens vandaan en kan opnieuw worden opgehaald of geüpload. Wat de bibliotheek bevat staat in de
database, dus een herstelde database zonder het volume toont bestanden die er niet zijn; de worker
merkt dat binnen een kwartier en zet ze op *Mislukt*, met als reden dat het bestand weg is, en ze
verwijderen op het scherm **ISO-bibliotheek** ruimt ze op. Is opnieuw ophalen voor jou duur, maak dan
ook een back-up van het volume:

```bash
sudo velnox backup library
```

### Oude back-ups verwijderen

Elke back-up is een nieuw bestand, en niets ruimt ze voor je op. Dit commando doet dat wel. Draai het
eerst zonder `--delete`: het toont wat het zou verwijderen en raakt niets aan.

```bash
sudo velnox backup prune
```

Als de lijst klopt met wat je verwacht, verwijder ze dan:

```bash
sudo velnox backup prune --delete
```

Standaard verwijdert het back-ups ouder dan 30 dagen en houdt het altijd de 7 nieuwste, hoe oud die
ook zijn. Beide zijn aan te passen:

```bash
sudo velnox backup prune --older-than=90 --keep=14 --delete
```

Wat het wel en niet doet:

- **Het kijkt alleen naar bestanden die precies `velnox-JJJJ-MM-DD.dump` of
  `velnox-JJJJ-MM-DD-UUMMSS.dump` heten** — de namen die `velnox backup` maakt. Al het andere in de
  map, en elke symlink, blijft staan.
- **De leeftijd van een dump is de datum in de naam, niet de wijzigingstijd van het bestand.** Een
  back-up die je terugkopieert van externe opslag krijgt een nieuwe wijzigingstijd; daarop afgaand zou
  hij nooit oud lijken.
- **De nieuwste back-up wordt nooit verwijderd.** `--keep` moet minstens 1 zijn, en een bestand
  waarvan de naam geen echte datum is (`velnox-2026-02-31.dump`) blijft staan en telt daar niet voor
  mee.
- **Het laat `.env`-back-ups met rust.** `scripts/gen-env.sh --force` schrijft een nieuwe `.env` met
  een nieuwe `MASTER_ENCRYPTION_KEY`, en bewaart het oude bestand als `.env.<tijdstempel>.bak`. Elke
  dump van vóór dat moment heeft de oude sleutel nodig om gelezen te worden, dus een `.bak`-bestand kan
  pas weg als geen dump die je bewaart ouder is. Dat is een afweging die het commando niet voor je kan
  maken.

---

## Schijfruimte vrijmaken

Eerst kijken, dan opruimen. Niets in deze sectie raakt de database.

### Waar de ruimte heen ging

```bash
sudo velnox disk
```

Het toont de vrije ruimte, wat Docker gebruikt, de grootste containerlogs, de back-ups en de
ISO-bibliotheek. Sinds 0.5.5 bewaart elke container hooguit vijf logbestanden van 10 MB — ongeveer
50 MB, of 350 MB voor de hele stack — en valt de oudste weg zodra er een nieuwe begint. Vóór 0.5.5 was
er helemaal geen limiet, en op een host die maanden draaide konden ze gigabytes groot worden.

### Opruimen

```bash
sudo velnox clean
```

Na een vraag verwijdert dit de Docker build cache, die de volgende upgrade opnieuw downloadt; images
die eerdere upgrades achterlieten, maar nooit een image dat een container gebruikt; systeemlogs boven
200 MB; en de pakketcache.

**Containerlogs van vóór 0.5.5.** Bijwerken ruimt ze vanzelf op: de wijziging die ze begrenst laat de
volgende `docker compose up -d` elke container opnieuw aanmaken, en de logs van een container gaan
mee. Die eerste upgrade herstart daardoor ook PostgreSQL — een paar seconden zonder console, en geen
gegevens kwijt, want de database staat in een volume en niet in de container.

Kun je nog niet bijwerken, maak ze dan leeg. De loggeschiedenis is weg, en daarmee ook voor het
oplossen van problemen, dus lees eerst wat je nodig hebt.

```bash
sudo sh -c 'truncate -s 0 /var/lib/docker/containers/*/*-json.log'
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

### Uitgaande mail

Velnox verstuurt mail als een VM die het bouwde klaar is. Stel de server in onder **Notificatiebeheer →
Uitgaande mail** — zie [VM's bouwen vanuit templates](building-vms.md#uitgaande-mail). De host moet
die server op zijn poort kunnen bereiken; de worker is wat verbinding maakt. Het wachtwoord van de
server staat versleuteld in de database, dus het zit in de databaseback-up en heeft `.env` nodig om te
worden gelezen, zoals elke andere credential.

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

Elke pagina en elk eindpunt vereist een sessie, op de bewust openbare na zoals de health checks. Rol
Velnox toch uit op een beheernetwerk achter een firewall: het beheert de infrastructuur van je
klanten, en hoort niet bereikbaar te zijn voor onvertrouwde mensen.

---

*De naam en het logo van Velnox worden gebruikt door The Velnox Foundation. Er is geen merk geregistreerd of geclaimd; de AGPLv3 verleent daar geen rechten op. Velnox is vrije software onder de AGPLv3.*

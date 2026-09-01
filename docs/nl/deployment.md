# Velnox — Uitrolhandleiding

> **Vertaling.** Bron: [docs/deployment.md](../deployment.md) @ `PLACEHOLDER`.
> **Engels is leidend.** Bij verschil tussen deze tekst en de Engelse versie geldt de Engelse tekst.

Hoe je Velnox draait op een Debian- of Ubuntu-host met Docker, hoe je het dimensioneert, en hoe je de
virtuele machine instelt op Proxmox VE, VMware ESXi/vSphere of Microsoft Hyper-V.

---

## Vooraf: wat deze build is

> **Fase 1 kent geen authenticatie.** Elk endpoint staat open en elke pagina is publiek.
> Authenticatie en RBAC komen in fase 2. Rol dit uit op een beheernetwerk dat je volledig beheert,
> achter een firewall — niet op iets dat vanaf internet bereikbaar is, en nergens waar onvertrouwde
> mensen bij kunnen.

Er is ook nog geen installer. `install.sh` en de tar.gz-/ISO-artefacten zijn fase 14; vandaag rol je
uit door een configuratiebestand te genereren en Docker Compose te draaien. Dat is wat deze
handleiding beschrijft, en het werkt.

---

## 1. Systeemeisen

### Besturingssysteem van de host

| Ondersteund | Versie |
|---|---|
| Debian | 12 (bookworm), 13 (trixie) |
| Ubuntu Server | 22.04 LTS, 24.04 LTS |

Uitsluitend 64-bits x86 (`amd64`). ARM64 is niet getest en de Prisma-engine en base images zijn daar
niet geverifieerd. Een minimale serverinstallatie volstaat — geen desktop, geen webserver, en niets
anders op poort 80 en 443.

### Dimensionering

De onderstaande waarden bij rust zijn **gemeten** op een draaiende fase 1-stack. De aanbevelingen
zijn **technische schattingen op basis van het ontwerp**, want de subsystemen die echt resources
verbruiken — inventaris, jobs, audit — komen in fase 4 tot en met 8. Ze staan er bewust als
schatting; herzie ze zodra er een echte omgeving achter hangt.

Gemeten, fase 1, in rust, lege database:

| Container | Geheugen |
|---|---|
| api | 47 MB |
| web | 42 MB |
| worker | 29 MB |
| postgres | 24 MB |
| caddy | 16 MB |
| redis | 6 MB |
| **Totaal** | **≈ 165 MB** |

Dat is een ondergrens, geen richtlijn. PostgreSQL groeit met zijn buffer cache en verbindingen, de
Node-processen groeien met request- en joblast, en de worker houdt per node waaraan hij werkt een
SSH- of HTTPS-sessie open.

| Schaal | vCPU | RAM | Schijf | Toelichting |
|---|---|---|---|---|
| **Evaluatie / fase 1** | 2 | 4 GB | 40 GB | Genoeg om op de host vanaf broncode te bouwen |
| **Kleine MSP** — tot ~10 clusters, ~50 nodes | 4 | 8 GB | 80 GB | Schatting |
| **Middelgrote MSP** — tot ~50 clusters, ~300 nodes | 8 | 16 GB | 200 GB | Schatting; overweeg een aparte PostgreSQL-host |

**Schijf, gemeten:** de zes images zijn samen **2,25 GB**. Ze op de host bouwen levert daarnaast een
build cache op die tijdens de ontwikkeling **13 GB** bereikte — op te ruimen met
`docker builder prune`. Rol je vooraf gebouwde images uit, dan heb je ruwweg 5 GB nodig; bouw je op
de host, reken dan op 40 GB zodat een build de schijf nooit voltrekt.

Daarna groeit de schijf mee met auditgebeurtenissen (onveranderlijk, bewaard volgens beleid),
joblogs en inventarismomentopnames. In fase 1 wordt er nauwelijks naar schijf geschreven.

### Netwerk

Inkomend naar de Velnox-host:

| Poort | Protocol | Vanaf | Doel |
|---|---|---|---|
| 443 | TCP | Werkplekken van operators | Web-UI en API |
| 80 | TCP | Werkplekken van operators | Doorverwijzing naar 443, en de ACME HTTP-challenge bij publieke certificaten |
| 22 | TCP | Je beheernetwerk | Hostbeheer (niet Velnox) |

Uitgaand **vanaf de Velnox-host** — alleen de `worker`-container heeft het merendeel hiervan nodig,
en Compose zet hem daarom op een eigen egressnetwerk:

| Poort | Protocol | Naar | Nodig vanaf |
|---|---|---|---|
| 8006 | TCP | Proxmox VE-nodes | Fase 4 |
| 22 | TCP | Proxmox VE-nodes (SSH) | Fase 6 |
| 443 | TCP | vCenter-/ESXi-hosts | Fase 11 |
| 5985 / 5986 | TCP | Hyper-V-hosts (WinRM) | Fase 12 |
| 443 | TCP | `login.microsoftonline.com` | Fase 2, alleen bij Entra ID SSO |
| 123 | UDP | Je NTP-servers | Altijd |

PostgreSQL en Redis zijn **niet** bereikbaar vanaf de host of het netwerk. Ze hangen aan een intern
Docker-netwerk zonder gepubliceerde poorten, en `verify-stack.sh` controleert dat dat zo blijft.

### Draai Velnox niet op een node die het beheert

Dit is de ene uitrolfout met echte gevolgen. Draait Velnox als VM op een Proxmox-node die Velnox
zelf beheert, dan zet het zichzelf uit op het moment dat het die node in onderhoud plaatst of
herstart voor een upgrade — middenin een job.

Draai het op een beheercluster, een aparte standalone host, of een hypervisor buiten de omgeving.
Heb je werkelijk maar één cluster, pin de Velnox-VM dan minimaal aan een node en sluit die node uit
van geautomatiseerde rolling updates — met de wetenschap dat je die node dan met de hand upgradet.

---

## 2. De virtuele machine

Velnox is een applicatie met een database eronder. De instellingen die ertoe doen zijn op elke
hypervisor dezelfde: **geparavirtualiseerde apparaten, vast geheugen, geen automatische snapshots
van de draaiende VM, en een kloppende klok.** Memory ballooning en de buffer cache van PostgreSQL
werken elkaar tegen, en een snapshot van een draaiende database is een crash-consistent beeld, geen
back-up.

### 2.1 Proxmox VE

| Instelling | Waarde | Waarom |
|---|---|---|
| Machine type | `q35` | Moderne chipset, echte PCIe |
| BIOS | `OVMF (UEFI)` + EFI-schijf | Sluit aan op hoe actuele Debian/Ubuntu installeren |
| CPU-type | `host` | Geeft alle CPU-vlaggen door — merkbaar sneller voor TLS en Argon2id-hashing |
| CPU (als de VM moet kunnen live-migreren) | `x86-64-v3` of een ander gedeeld model | `host` blokkeert migratie tussen ongelijke CPU's |
| Cores | 2 (evaluatie) tot 8 | 1 socket, alle cores daarop |
| Geheugen | Vast, **ballooning uit** | Vink "Ballooning Device" uit; een krimpende balloon onder een database veroorzaakt swapstormen |
| SCSI-controller | `VirtIO SCSI single` | |
| Schijfbus | `SCSI`, `Discard=on`, `IO thread=on` | Discard geeft verwijderde ruimte terug aan thin storage |
| Schijfcache | `Default (no cache)` | Veilig bij een database; `writeback` riskeert de laatste writes bij een hostfout |
| SSD-emulatie | Aan, bij SSD/NVMe eronder | Juiste rotational-hint naar de guest |
| Netwerk | `VirtIO (paravirtualized)` | |
| QEMU Guest Agent | Ingeschakeld | Nodig voor nette afsluiting en filesystem freeze |
| Starten bij opstarten | Ja, met een startvertraging achter je opslag | |

Installeer de agent in de guest, anders wacht Proxmox bij het afsluiten en krijgt het nooit een nette
shutdown:

```bash
sudo apt-get install -y qemu-guest-agent && sudo systemctl enable --now qemu-guest-agent
```

Back de VM op met Proxmox Backup Server in **snapshot-modus met de guest agent ingeschakeld**, zodat
`fsfreeze` vóór de snapshot draait. Dat geeft een consistent filesystem, maar zie §7 — het vervangt
een databasedump niet.

### 2.2 VMware ESXi / vSphere

| Instelling | Waarde | Waarom |
|---|---|---|
| VM-compatibiliteit | Hardwareversie 19 of hoger (ESXi 7.0 U2+) | |
| Gast-OS | `Debian GNU/Linux 12 (64-bit)` of `Ubuntu Linux (64-bit)` | Zet verstandige standaardapparaten |
| Firmware | `EFI` | Secure Boot mag aan blijven; Debian en Ubuntu zijn ondertekend |
| SCSI-controller | **VMware Paravirtual (PVSCSI)** | Wezenlijk minder CPU per I/O dan LSI Logic |
| Netwerkadapter | **VMXNET3** | Nooit E1000/E1000E — meer CPU, minder doorvoer |
| Schijfprovisioning | Thick provisioned, **eager zeroed** | Vermijdt de first-write-straf op databasebestanden |
| Geheugenreservering | Reserveer **al** het gastgeheugen | Voorkomt dat ESXi de database balloont of swapt |
| CPU-/geheugen-hot-add | **Uitgeschakeld** | Geheugen-hot-add schakelt vNUMA uit, wat een VM met meerdere vCPU's schaadt |
| CPU-shares/limieten | Geen limiet | Een CPU-limiet op een joborkestrator geeft onvoorspelbare timeouts |
| Latency sensitivity | Normal | |

Installeer `open-vm-tools` in de guest (Debian en Ubuntu leveren het als pakket; gebruik niet de
ISO-gebaseerde VMware Tools):

```bash
sudo apt-get install -y open-vm-tools
```

Maak je snapshots van de VM, gebruik dan **quiesced** snapshots zodat `open-vm-tools` het filesystem
bevriest — en verwijder ze snel. Een langlevende snapshot op een database-VM laat een deltabestand
groeien dat de schrijfprestaties elke dag verder verslechtert.

### 2.3 Microsoft Hyper-V

| Instelling | Waarde | Waarom |
|---|---|---|
| Generatie | **Generatie 2** | UEFI, synthetische apparaten, geen geëmuleerde legacy hardware |
| Secure Boot | Aan, sjabloon **"Microsoft UEFI Certificate Authority"** | Het standaard Windows-sjabloon start Linux niet op. Dit is de meest gemaakte Hyper-V-fout. |
| Dynamic Memory | **Uitgeschakeld** — zet een vaste hoeveelheid | De belangrijkste instelling hier; zie hieronder |
| Virtuele processors | 2 tot 8 | |
| Netwerkadapter | De standaard synthetische adapter | Nooit "Legacy Network Adapter" |
| VHDX | Vaste grootte, op SSD/NVMe | Het uitbreiden van een dynamische VHDX stokt databaseschrijfacties |
| Automatic Start Action | Altijd automatisch starten | |
| Automatic Stop Action | **Shut down** | Niet "Save state" — een hervatte database-VM herstelt verouderde toestand uit het geheugen |
| Automatic Checkpoints | **Uitgeschakeld** | Staat standaard aan op Windows 10/11; een checkpoint van een draaiende database is geen back-up |
| Integration Services | Guest Services en Heartbeat aan | |

**Waarom Dynamic Memory uit moet:** Hyper-V haalt geheugen terug uit de guest via een balloondriver,
op basis van de druk die het waarneemt. PostgreSQL vult geheugen bewust met zijn buffer cache, dus de
guest lijkt "vol" en Hyper-V geeft méér; daarna komt de host onder druk, haalt terug, en de working
set van de database wordt naar swap geduwd. Het resultaat is een systeem dat snel is tot het dat
plotseling niet meer is. Geef het een vaste toewijzing.

Zet het Secure Boot-sjabloon via PowerShell als de keuzelijst in de GUI niet duidelijk is:

```powershell
Set-VMFirmware -VMName "velnox" -SecureBootTemplate "MicrosoftUEFICertificateAuthority"
```

Schakel automatische checkpoints uit:

```powershell
Set-VM -VMName "velnox" -AutomaticCheckpointsEnabled $false -AutomaticStopAction ShutDown
```

Tijd haal je op Linux-guests onder Hyper-V het beste uit het PTP-apparaat van de host, in plaats van
NTP te laten vechten met de Hyper-V-tijdsynchronisatie:

```bash
sudo apt-get install -y chrony
echo 'refclock PHC /dev/ptp_hyperv poll 3 dpoll -2 offset 0' | sudo tee /etc/chrony/conf.d/hyperv.conf
sudo systemctl restart chrony
```

### 2.4 Geldt voor alle drie

- **De tijd moet kloppen.** Velnox geeft TLS-certificaten uit en valideert ze, ondertekent kortlevende
  tokens en beoordeelt onderhoudsvensters. Een host met een afwijkende klok levert
  authenticatiefouten op die op bugs lijken. Controleer met `timedatectl` —
  `System clock synchronized: yes`.
- **Filesystem:** `ext4` of `xfs` voor `/var/lib/docker`. Gebruik je `xfs`, dan moet het geformatteerd
  zijn met `ftype=1`; dat is de standaard op Debian en Ubuntu maar niet op elk ouder systeem, en de
  overlay2-driver van Docker weigert zonder.
- **Swap:** houd een kleine swap aan maar zet `vm.swappiness=10`. Een database wegswappen is erger dan
  het geheugen niet hebben.
- **Een hypervisorsnapshot is geen back-up.** Hij legt de database midden in een schrijfactie vast.
  Gebruik hem om een mislukte upgrade minuten later terug te draaien, niet om data te herstellen. §7
  beschrijft de echte back-up.

---

## 3. De host voorbereiden

Alles hieronder draait als gewone gebruiker met `sudo`.

```bash
sudo apt-get update && sudo apt-get upgrade -y
```

```bash
sudo apt-get install -y ca-certificates curl git gnupg chrony
```

Zet hostnaam en tijdzone zodat logs en onderhoudsvensters kloppen:

```bash
sudo hostnamectl set-hostname velnox
sudo timedatectl set-timezone Europe/Amsterdam
```

Controleer dat de klok gesynchroniseerd is voordat je verdergaat:

```bash
timedatectl
```

### Firewall

Velnox publiceert alleen 80 en 443. Verder hoeft niets bereikbaar te zijn.

```bash
sudo apt-get install -y ufw && sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw --force enable
```

> **Let op bij ufw en Docker:** Docker schrijft zijn eigen iptables-regels en kan een containerpoort
> langs een ufw-regel publiceren. Velnox publiceert alleen 80 en 443, die je toch al toestaat, en
> PostgreSQL en Redis hangen aan een intern netwerk zonder gepubliceerde poorten — hier speelt het dus
> niet. Voeg je later een service met een gepubliceerde poort toe, beperk die dan in het
> Compose-bestand (`127.0.0.1:POORT:POORT`) in plaats van op ufw te vertrouwen.

### Onbewaakte beveiligingsupdates

```bash
sudo apt-get install -y unattended-upgrades && sudo dpkg-reconfigure -plow unattended-upgrades
```

---

## 4. Docker installeren

Gebruik de eigen repository van Docker. Het pakket `docker.io` in Debian en Ubuntu loopt ver achter
en levert geen Compose v2.

Voeg de repository toe — dit is gelijk voor Debian en Ubuntu, op de distributienaam na, die het
commando uit `/etc/os-release` haalt:

```bash
sudo install -m 0755 -d /etc/apt/keyrings && curl -fsSL "https://download.docker.com/linux/$(. /etc/os-release && echo "$ID")/gpg" | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg && sudo chmod a+r /etc/apt/keyrings/docker.gpg
```

```bash
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$(. /etc/os-release && echo "$ID") $(. /etc/os-release && echo "${VERSION_CODENAME:-$UBUNTU_CODENAME}") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
```

```bash
sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

> Meldt `apt-get update` dat de repository geen `Release`-bestand heeft, dan heeft Docker nog geen
> pakketten gepubliceerd voor jouw releasecodenaam — dat gebeurt een tijdlang na elke nieuwe Debian-
> of Ubuntu-release. Vervang de codenaam in `/etc/apt/sources.list.d/docker.list` door de vorige
> stabiele (`bookworm` voor Debian 13, `noble` voor een nieuwere Ubuntu) en werk opnieuw bij. De
> pakketten zijn compatibel; alleen de repository-index ontbreekt.

Zet het aan bij opstarten en controleer de versies:

```bash
sudo systemctl enable --now docker && docker --version && docker compose version
```

Compose moet **v2.x of hoger** melden. Werkt `docker compose version` niet maar `docker-compose`
wel, dan heb je het verouderde v1 en wordt het Compose-bestand hier niet geparseerd.

### Docker zonder sudo draaien (optioneel)

```bash
sudo usermod -aG docker "$USER" && newgrp docker
```

> Lidmaatschap van de groep `docker` staat gelijk aan root op de host: elk lid kan een container
> starten die `/` mount. Voeg alleen accounts toe die je ook root zou geven.

---

## 5. Velnox uitrollen

### 5.1 De broncode ophalen

```bash
sudo mkdir -p /opt/velnox && sudo chown "$USER" /opt/velnox && git clone <url-van-je-velnox-repository> /opt/velnox
```

Vanaf fase 14 komt er een ondertekende tar.gz die de images meedraagt, waardoor deze stap een
uitpakactie wordt die volledig zonder registry-toegang werkt.

### 5.2 De configuratie genereren

```bash
cd /opt/velnox && ./scripts/gen-env.sh
```

Dit schrijft `.env` met modus 0600 en sterke willekeurige waarden voor `POSTGRES_PASSWORD`,
`REDIS_PASSWORD`, `JWT_SECRET` en `MASTER_ENCRYPTION_KEY`. Opnieuw uitvoeren overschrijft nooit een
bestaande `.env` — de hoofdsleutel kwijtraken is onherstelbaar, dus het script weigert liever.

> ### Maak nu een back-up van `MASTER_ENCRYPTION_KEY`
>
> Elk credential dat Velnox opslaat is versleuteld met een sleutel die daarvan is afgeleid. Raak je
> hem kwijt, dan wordt elk opgeslagen Proxmox- en hypervisorcredential definitief onleesbaar. Er is
> geen herstelpad — dat is een ontwerpkeuze. Zet hem in je wachtwoordmanager **voordat** je verdergaat.

### 5.3 Het adres instellen

Bewerk `.env` en zet het adres dat operators gaan gebruiken:

```ini
VELNOX_SITE_ADDRESS=velnox.example.internal
APP_URL=https://velnox.example.internal
VELNOX_TLS=internal
```

Met `VELNOX_TLS=internal` geeft Caddy een eigen certificaat uit. Browsers waarschuwen één keer; dat
is verwacht en juist voor een appliance op een beheernetwerk. Wil je publiek vertrouwde certificaten,
zet `VELNOX_TLS` dan op een e-mailadres — dat vereist dat `VELNOX_SITE_ADDRESS` een publiek
resolvebare naam is die vanaf internet bereikbaar is op poort 80 en 443.

Bepaal meteen wat je met het diagnostische endpoint uit fase 1 doet:

```ini
VELNOX_DEV_ENDPOINTS=false
```

Zet het alleen op `true` als je de wachtrij-zelftest op het dashboard wilt. Hij is
niet-geauthenticeerd, net als al het andere in deze build.

### 5.4 Starten

```bash
cd /opt/velnox && docker compose -f deploy/compose/docker-compose.yml --env-file .env up --build --detach --wait
```

De eerste keer bouwt hij beide images en duurt dat enkele minuten. Door `--wait` keert het commando
pas terug wanneer elke health check slaagt; komt het succesvol terug, dan staat de stack er echt.

### 5.5 Verifiëren

```bash
./scripts/verify-stack.sh https://velnox.example.internal
```

Dit toetst de acceptatiecriteria tegen het draaiende systeem: elke afhankelijkheid bereikbaar, de
schemamigratie toegepast, security headers aanwezig, beide talen geserveerd, het bronaanbod
gepubliceerd, een echte job die door de wachtrij afrondt, en de datalaag die niet aan de host is
blootgesteld. Het hoort te eindigen met `27 checks passed.`

Open daarna `https://velnox.example.internal` in een browser.

### 5.6 Starten bij opstarten

De Compose-services gebruiken `restart: unless-stopped`, dus Docker herstart ze na een reboot van de
host — mits de Docker-service zelf start, wat §4 heeft ingeschakeld. Controleer dat na je eerste
herstart:

```bash
sudo reboot
```

```bash
cd /opt/velnox && docker compose -f deploy/compose/docker-compose.yml --env-file .env ps
```

---

## 6. Dagelijks beheer

Draai deze commando's vanuit `/opt/velnox`. Het paar `-f`/`--env-file` is elke keer nodig; de
`package.json` van de repository verpakt ze als `pnpm docker:up` en `pnpm docker:logs` als je Node op
de host hebt staan.

Status:

```bash
docker compose -f deploy/compose/docker-compose.yml --env-file .env ps
```

Logs van één service volgen:

```bash
docker compose -f deploy/compose/docker-compose.yml --env-file .env logs -f api
```

Eén service herstarten:

```bash
docker compose -f deploy/compose/docker-compose.yml --env-file .env restart worker
```

Alles stoppen (data blijft behouden — die staat in named volumes):

```bash
docker compose -f deploy/compose/docker-compose.yml --env-file .env down
```

### Bijwerken naar een nieuwe versie

```bash
cd /opt/velnox && git pull && docker compose -f deploy/compose/docker-compose.yml --env-file .env up --build --detach --wait
```

Migraties draaien in een eenmalige container die succesvol moet eindigen voordat de API start, dus
een mislukte migratie stopt de uitrol in plaats van een bedienende container achter te laten tegen een
schema dat hij niet kent. Opnieuw uitvoeren is veilig en behoudt `.env` en alle data.

Ruim daarna de build cache op — die groeit snel:

```bash
docker builder prune -f
```

---

## 7. Back-up en herstel

Drie dingen moeten geback-upt worden, en één daarvan zit niet in de database.

**1. De database:**

```bash
cd /opt/velnox && docker compose -f deploy/compose/docker-compose.yml --env-file .env exec -T postgres pg_dump -U velnox -d velnox --format=custom > "velnox-$(date +%F).dump"
```

**2. Het bestand `.env`** — daar staat `MASTER_ENCRYPTION_KEY` in. Een databaseback-up zonder die
sleutel is een back-up van ciphertext die je nooit meer kunt ontsleutelen.

**3. Je `docker-compose.yml` en eventuele lokale aanpassingen**, die `git` al bijhoudt.

Herstel in een verse installatie door eerst `.env` terug te zetten, de stack te starten zodat de
migraties het schema aanmaken, en dan:

```bash
cd /opt/velnox && docker compose -f deploy/compose/docker-compose.yml --env-file .env exec -T postgres pg_restore -U velnox -d velnox --clean --if-exists < velnox-2026-09-01.dump
```

**Test het herstel voordat je erop vertrouwt.** Een back-up die je nooit hebt teruggezet is een
hypothese.

---

## 8. Problemen oplossen

**`docker compose version` meldt v1 of bestaat niet**
Je hebt het verouderde pakket van de distributie. Verwijder `docker-compose` en installeer
`docker-compose-plugin` uit de repository van Docker (§4).

**Poort 80 of 443 al in gebruik**
Er luistert iets anders — meestal Apache of nginx uit een standaardinstallatie. Verwijder het, of zet
`CADDY_HTTP_PORT` en `CADDY_HTTPS_PORT` in `.env` op vrije poorten en zet je eigen proxy ervoor.

**`migrate` eindigt met 1 en de API start nooit**
Lees het log: `docker compose ... logs migrate`. De twee gebruikelijke oorzaken zijn PostgreSQL dat
nog niet gezond is (Compose wacht daarop, dus dit is zeldzaam) en een `DATABASE_URL` in `.env` waarvan
het wachtwoord niet meer overeenkomt met `POSTGRES_PASSWORD` — makkelijk te veroorzaken door het ene
aan te passen en het andere niet.

**De browser waarschuwt over het certificaat**
Verwacht bij `VELNOX_TLS=internal`. Accepteer het, verspreid de root-CA van Caddy uit
`docker compose ... exec caddy cat /data/caddy/pki/authorities/local/root.crt` onder je operators, of
stap over op ACME met een publieke hostnaam.

**`readyz` meldt de worker als verminderd**
De worker ververst elke 10 seconden een hartslag in Redis en wordt boven 45 seconden als verminderd
gemeld — niet als uitgevallen, want de API kan blijven bedienen terwijl de worker herstart. Blijft het
verminderd, kijk dan in `docker compose ... logs worker`.

**De stack is gezond maar de schijf loopt vol**
Vrijwel altijd de build cache. `docker system df` laat het zien; `docker builder prune -f` ruimt op.

---

## 9. Wat er in fase 14 verandert

De installer vervangt het merendeel van §3 tot §5 door:

```bash
sudo ./install.sh
```

Die controleert het besturingssysteem, installeert Docker als het ontbreekt, genereert de
configuratie en de secrets, draait de migraties, start de stack, verifieert de gezondheid en toont het
adres. Hij is idempotent — opnieuw uitvoeren behoudt een bestaande `.env` en de data — en heeft een
modus `--non-interactive`. Het tar.gz-artefact draagt de images mee, zodat het geheel zonder
registry-toegang werkt.

Tot die tijd is deze handleiding het ondersteunde pad.

---

*Velnox™ is een handelsmerk van The Velnox Foundation. Velnox is vrije software onder de AGPLv3.*

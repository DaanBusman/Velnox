# Clusters toevoegen en de inventarisatie lezen

> **Vertaling.** Bron: [docs/managing-infrastructure.md](../managing-infrastructure.md) @ `f224c8c`.
> **Engels is leidend.** Bij verschil tussen deze tekst en de Engelse versie geldt de Engelse tekst.

**Alles over het onder beheer brengen van Proxmox en weten wat er staat.** Elk hoofdstuk is één taak,
geschreven om te lezen terwijl je hem uitvoert.

Voor tenants en locaties, zie [Je omgeving indelen](organising-your-fleet.md). Voor accounts en
rollen, zie [Gebruikers en toegang beheren](managing-access.md).

---

## Cluster en node: de twee woorden

- Een **node** is één fysieke server waarop Proxmox VE draait.
- Een **cluster** is één Proxmox VE-installatie zoals Velnox ermee verbindt, via één API-adres:
  meerdere nodes samen in een Proxmox-cluster, of één losse node — een cluster van één.

Elke node hoort bij precies één cluster. Je voegt een **cluster** toe aan Velnox — nooit een losse
node — en zijn nodes komen mee, omdat het cluster ze meldt. Twee losse servers die apart zijn
toegevoegd, zijn twee clusters met elk één node; voeg je ze in Proxmox samen, dan worden ze daar één
cluster, en Velnox biedt aan [de twee registraties samen te voegen](#twee-registraties-van-n-cluster-samenvoegen).

---

## Wat Velnox leest, en waar het niet aan komt

In deze fase is Velnox **alleen-lezen op je infrastructuur**. Het maakt verbinding, vraagt Proxmox
wat er staat, en legt dat vast. Het start, stopt, migreert, update of herconfigureert niets — dat
komt in latere fasen, elk met een eigen goedkeuring en eigen waarborgen.

Wat het per cluster leest:

- het cluster zelf: naam, versie, quorum, en of de nodes het eens zijn over hun versie;
- elke node: status, Proxmox- en kernelversie, CPU, geheugen, systeemschijf, draaitijd, abonnement,
  hoeveel pakketupdates openstaan, en de apt-bronnen;
- de opslag en netwerkinterfaces van elke node;
- elke virtuele machine en container, met ID, naam, status, omvang en labels;
- Ceph, als dat er is: gezondheid, monitorquorum, OSD-aantallen, de status van de placement groups,
  de versie van elke daemon, en welke vlaggen aan staan.

---

## Eerst: maak een API-token

Je kunt je met gebruikersnaam en wachtwoord aanmelden, en dat kun je beter niet doen. Een token is
beperkt in bereik, kan aan de Proxmox-kant worden ingetrokken zonder iemands wachtwoord aan te raken,
overleeft een wachtwoordwijziging, en verloopt niet na twee uur. Met een wachtwoord krijgt Velnox
alles wat dat account mag.

Op een willekeurige node van het cluster:

1. **Datacenter → Permissions → API Tokens → Add.**
2. Gebruiker `root@pam` (of een aparte gebruiker — zie hieronder). Token-ID `velnox`.
3. **Laat "Privilege Separation" uit** voor een eerste blik, of zet hem aan en geef het token
   alleen wat Velnox gebruikt. `PVEAuditor` op `/` is genoeg voor de inventarisatie. ISO's naar opslag
   kopiëren en VM's bouwen vraagt meer — zie
   [VM's bouwen vanuit templates](building-vms.md#wat-er-eerst-nodig-is) voor de lijst.
4. Kopieer het geheim. Proxmox toont het **één keer**.

Het token-id is de volledige tekst die Proxmox toont, realm inbegrepen: `root@pam!velnox`.

### Een aparte gebruiker is beter dan root

Maak `velnox@pve` aan, geef die `PVEAuditor` op `/` — en de rollen in
[VM's bouwen vanuit templates](building-vms.md#wat-er-eerst-nodig-is) als hij moet schrijven — en
maak het token daarop. Dan kan een
Velnox-token niet verward worden met dat van een mens, raakt intrekken niets anders, en schrijft het
Proxmox-tasklogboek leesacties toe aan iets met een naam.

---

## Een cluster toevoegen

**Je hebt nodig:** `clusters.manage`, dekkend voor de tenant waaraan je hem toevoegt.

Wijs Velnox naar **één willekeurige node**. Proxmox antwoordt vanaf elk lid voor het hele cluster,
dus er is geen "primaire" node te kiezen en er verandert niets als die node later opnieuw wordt
opgebouwd.

1. Ga naar **Clusters → Cluster toevoegen**.
2. Vul host en poort in (8006, tenzij je die verplaatst hebt). **Opzoeken.**
3. Velnox maakt verbinding, leest het certificaat en toont de vingerafdruk. **Er wordt niets
   verstuurd** — geen token, geen wachtwoord, geen cookie. Op dit moment heeft niemand gezegd dat dit
   de juiste machine is.
4. **Controleer de vingerafdruk op de node zelf.** Meld je aan via SSH of de console en voer uit:

   ```bash
   pvenode cert info
   ```

   Vergelijk de SHA-256-vingerafdruk. Vink het vakje pas aan als hij overeenkomt.
5. Geef hem een naam, kies de tenant en eventueel een locatie, plak het token-id en het geheim, en
   **Cluster toevoegen**.

Velnox slaat de credential versleuteld op en toetst hem daarna tegen het certificaat dat je zojuist
bevestigd hebt. Klopt het token niet, dan wordt er niets toegevoegd — je krijgt de fout en een leeg
formulier, geen half toegevoegd cluster dat daarna elk half uur stilletjes faalt.

### Waarom stap 4 niet optioneel is

Op die vingerafdruk rust de hele beveiliging van de verbinding. Vanaf dat moment praat Velnox met
**dat ene certificaat** en weigert al het andere — en het weigert tijdens de handshake, voordat er
één byte van je API-token naar de socket geschreven is.

Sla je die stap over, dan heb je ermee ingestemd een credential dat de configuratie van elke VM kan
lezen te sturen naar wat er ook maar op poort 8006 antwoordde. Een beheernetwerk is geen veilig
netwerk; het is een netwerk waar de gevolgen groter zijn.

### Een standalone node

Precies dezelfde stappen. Eén node vormt geen cluster, en Velnox modelleert hem als een cluster van
één — hij verschijnt met de aanduiding **Standalone node**, en wordt gerapporteerd als "geen quorum" in
plaats van "quorum verloren".

Alles daarachter behandelt hem identiek, en daarom is er geen apart scherm om een node toe te voegen,
en komt dat er ook niet als de rolling updates landen.

---

## Waar de credential blijft

Het token wordt versleuteld opgeslagen en kan alleen door de worker ontsleuteld worden — de service
zonder luisterende poort, het enige deel van Velnox dat met je infrastructuur praat. De console kan
het niet teruglezen: de API weigert elke infrastructuur-credential te ontsleutelen, en er is geen
instelling die dat verandert.

Wat je wél kunt zien is welk token in gebruik is, zodat je weet wat je moet intrekken: het tabblad
**Verbinding** van het cluster toont het token-id en de vastgelegde vingerafdruk, nooit het geheim.

**Waar verwijderen staat.** Onderaan de clusterpagina, onder welk tabblad je ook openhebt, bij **Dit
cluster verwijderen**. De nodes en guests gaan mee. Een losse node verwijderen kan niet, en dat komt
er ook niet: een node staat in de inventarisatie omdat het cluster hem meldt, dus de volgende
uitleesronde zou hem gewoon terugbrengen.

Een cluster verwijderen verwijdert ook de opgeslagen credential. Een geheim zonder eigenaar is een
geheim dat niemand gaat roteren.

---

## SSH: waarvoor het is, en het instellen

De Proxmox-API dekt de inventarisatie, het uitlezen, VM's bouwen en guests verplaatsen. Wat hij niet
kan, doet Velnox via SSH naar elke node:

| Wat | Via SSH | Het account heeft nodig |
|---|---|---|
| Een ISO of schijfimage van een node naar de bibliotheek kopiëren | SFTP, één bestand lezen | Leestoegang tot de opslagmap |
| Updates toepassen, rolling updates | Drie vaste opdrachten — zie [Nodes bijwerken](updating-nodes.md#voordat-je-updates-kunt-toepassen-ssh) | root, of sudo voor de dist-upgrade |
| Grote upgrades van Ceph en Proxmox VE | Vaste opdrachten per stap — zie [Grote upgrades](major-upgrades.md) | root |

Velnox opent nooit een shell, en voert nooit een opdracht uit die iemand typt of die via de API
binnenkomt: elke opdracht staat in een vaste lijst in Velnox (ADR-046) en verschijnt in de uitvoer van
de job. **root is het eenvoudigste account**, en het enige waarmee alles zonder verdere instelling
werkt.

### Instellen

Op de pagina van het cluster, tabblad **Verbinding**, kaart **SSH**, **SSH instellen**:

1. **Lees en bevestig de hostsleutel van elke node.** Velnox maakt verbinding met elke online node en
   legt de sleutel vast die hij toont, **zonder in te loggen**. Vergelijk elke vingerafdruk met de
   node zelf voordat je hem aanvinkt — op de node:

   ```bash
   ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
   ```

2. **Het account** waarmee Velnox inlogt — `root`, tenzij je het verandert.
3. **De sleutel.** Een van beide:
   - **Maak hier een nieuw sleutelpaar** — de standaard. Je browser maakt een Ed25519-sleutelpaar, en
     Velnox toont de **publieke sleutel**, één regel die begint met `ssh-ed25519`, met **Kopiëren**, en
     de opdracht die hem op een node toevoegt:

     ```bash
     echo 'ssh-ed25519 AAAA… velnox' >> /root/.ssh/authorized_keys
     ```

     Op een Proxmox-cluster is `/root/.ssh/authorized_keys` normaal een link naar
     `/etc/pve/priv/authorized_keys`, één bestand dat alle nodes delen, dus voor root is het meestal
     genoeg om dit één keer op een willekeurige node te draaien. Controleer met
     `ls -l /root/.ssh/authorized_keys`; is het geen link, draai het dan op elke node. Voor een ander
     account is het de `~/.ssh/authorized_keys` van dat account.
   - **Gebruik een sleutelpaar dat je al hebt.** Plak de private sleutel, en de wachtwoordzin als hij
     er een heeft. De publieke helft moet al in de `authorized_keys` van het account staan.
4. **Opslaan en de bevestigde nodes vertrouwen.** Velnox slaat de private sleutel versleuteld op en
   bewijst hem op elke bevestigde node. Weigert een node — meestal omdat de publieke sleutel er nog
   niet op staat — dan wordt er niets opgeslagen en blijft de vorige instelling, als die er was, zoals
   hij was. Een hier gemaakte sleutel blijft in het formulier tot je het sluit, dus zet de publieke
   sleutel waar hij ontbreekt en sla opnieuw op.

### Waar de publieke sleutel daarna staat

Op dezelfde kaart **SSH**, als **Publieke sleutel** met **Kopiëren**, zolang SSH is ingesteld — voor
een hier gemaakte sleutel en voor een geplakte. Het is de regel voor een node die later bij het
cluster komt, of om terug te zetten na het herinstalleren van een node. De **private** sleutel wordt
nooit meer getoond, door geen enkel scherm en geen enkele API-aanroep.

**Sleutel vervangen** doorloopt dezelfde stappen met een nieuwe sleutel; **SSH verwijderen** verwijdert
de sleutel en de vastgepinde hostsleutels. Haal de oude publieke regel zelf uit `authorized_keys`:
Velnox bewerkt dat bestand niet.

**Een node waarvan de hostsleutel verandert, wordt geweigerd**, net zoals een veranderd
TLS-certificaat. Stel na het herinstalleren van een node SSH opnieuw in en bevestig zijn nieuwe sleutel
bewust. Met een node die later aan het cluster wordt toegevoegd, wordt geen verbinding gemaakt tot je
hetzelfde doet.

---

## Twee registraties van één cluster samenvoegen

Twee losse servers die één voor één aan Velnox zijn toegevoegd — **PVE-1** en **PVE-2** — en daarna
in Proxmox tot één cluster zijn samengevoegd (`pvecm create PVE-PROD` op de ene, `pvecm add` op de
andere) zijn in Velnox nog twee registraties, die nu allebei dezelfde nodes melden. Velnox merkt het
op: bij de volgende uitleesronde melden beide dezelfde clusternaam van Proxmox en gedeelde nodes, en
de pagina **Clusters** zegt dat, met **Samenvoegen tot één**.

Het samenvoegen, in een venster boven de pagina:

1. **Naam in Velnox** — voorgesteld als de naam die Proxmox het cluster geeft, `PVE-PROD`.
2. **Houd de verbinding van** — de registratie waarvan het API-adres en token blijven. Die van de
   andere worden verwijderd.
3. **Houd de SSH-instelling van** — alleen gevraagd als beide er een hebben.

**Wat er meegaat** van de registratie die verdwijnt: de SSH-instelling en vastgepinde hostsleutels,
plaatsingsregels en -instellingen, het updatebeleid, upgradeplannen, VM-builds, bibliotheekbronnen,
de job- en uitleesgeschiedenis, en de locatie. Waar de behouden registratie al een eigen heeft — een
updatebeleid, een locatie — blijft die, en het samenvoegen zegt wat niet is overgenomen. De nodes en
gasten worden niet gekopieerd: het is hetzelfde cluster, en het wordt direct daarna opnieuw uitgelezen.
De andere registratie wordt daarna verwijderd, met zijn API-token. Samenvoegen staat op beide in het
auditlog.

**Wat het weigert.** Twee registraties die niet één Proxmox-cluster zijn — samenvoegen zou er een uit
Velnox laten verdwijnen — en samenvoegen terwijl er een job tegen een van beide draait. **Velnox voegt
zelf geen nodes samen in Proxmox:** het cluster vorm je in Proxmox, zoals altijd. Je hebt
`clusters.manage` op beide nodig.

---

## De inventarisatie lezen

**Clusters** is het geheel in één oogopslag. Vier kolommen dragen dat:

| Kolom | Waar je op let |
|---|---|
| Gezondheid | Grijs is *onbekend*, niet goed. Een cluster waarover Velnox niets weet is nooit groen. |
| Versie | Twee versies betekent dat het cluster halverwege een upgrade staat. |
| Gasten | Een aantal. Nul op een cluster dat er wel zou moeten hebben, betekent dat het uitlezen niet werkt. |
| Laatst uitgelezen | **De kolom die men vergeet.** Een inventarisatie van een week oud ziet er precies zo uit als een actuele. |

Open een cluster voor de nodes, de gasten, Ceph en — op het tabblad **Uitleesrondes** — wat de laatste
pogingen wel en niet konden lezen.

**Nodes**, **Virtuele machines** en **Containers** tonen dezelfde gegevens over alle clusters die je
kunt zien, voor wanneer de vraag "waar staat die schijf" is in plaats van "hoe gaat het met dit
cluster".

**Opslag** en **Netwerken** worden per cluster getoond, binnen één tenant — ook de MSP-organisatie.
Staat in de bovenbalk *alle tenants* geselecteerd, dan vragen ze eerst er een te kiezen; kies daarna
het cluster boven de tabel. Elke kolom is te filteren: typ in het vak onder een naam of een adres, of
kies een type, node of status uit de lijst. *Filters wissen* toont weer alles.

### Cijfers die ontbreken, en cijfers die nul zijn

Een streepje betekent dat Velnox dat getal niet heeft. Een nul betekent dat het getal nul is. Dat
zijn verschillende feiten en de interface haalt ze nooit door elkaar — een opslag die geconfigureerd
is maar niet aangekoppeld toont streepjes, geen lege schijf.

---

## Uitlezen: wanneer het gebeurt, en wat er gebeurt als iets kapot is

Er zijn twee soorten uitlezen, en ze verschillen:

- **De volledige inventarisatie** — versies, repositories, updates, Ceph, interfaces, bestanden op
  opslag — wordt volgens schema uitgelezen, standaard elke 30 minuten. Wijzig dat per cluster op de
  clusterpagina, of zet het op **Alleen op verzoek** om het schema voor één klant uit te zetten zonder
  iemand anders te raken.
- **Live status** — of elke node en gast draait, CPU, geheugen, uptime, opslaggebruik, en gasten die
  zijn aangemaakt of verwijderd — wordt uitgelezen zolang iemand kijkt. Elk open scherm met de
  inventaris van een cluster vraagt erom op het verversinterval van de kijker (je naam → **Instellingen → Schermen
  automatisch verversen**, standaard twee seconden); de kijker die het vaakst ververst bepaalt het
  tempo, en ongeveer tien seconden nadat de laatste kijker weg is stopt het. Het is één aanroep naar
  Proxmox (`/cluster/resources`) per cluster. Staat verversen uit, dan vraagt een scherm er niet om.
  De clusterpagina toont onder *Live status* wat er geldt.

  Het scherm zelf leest alleen opnieuw als er iets veranderde wat het toont — een gast gestart of
  gestopt, een node offline, een cijfer dat een hele procent CPU of meer dan een paar megabyte
  verschoof — en verder eens per minuut. Een cluster waarop niets beweegt, kost de schermen die
  ernaar kijken niets.

Proxmox rekent die cijfers zelf ongeveer elke tien seconden opnieuw uit, dus tussen twee van zijn
updates tonen meerdere uitlezingen achter elkaar dezelfde getallen. Er is geen knop die een volledige
inventarisatie op verzoek start; een ronde buiten het schema betekent het interval voor dat cluster
verkorten.

Drie gedragingen zijn het weten waard, want die maken de inventarisatie betrouwbaar:

- **Een node die niet bereikbaar is kost je de rest niet.** De ronde loopt af, de andere nodes worden
  bijgewerkt, en de ronde wordt **Gedeeltelijk** genoemd met de node erbij. Een offline node blijft in
  de inventarisatie staan — juist als een node uit ligt wil je hem zien.
- **Een mislukte ronde wist niets.** Kan Velnox het cluster helemaal niet bereiken, dan blijft de
  vorige inventarisatie precies zoals hij was en wordt het cluster als falend gemarkeerd. Wat stopt
  met bewegen is *laatst uitgelezen*, en daaraan zie je verouderd van actueel.
- **Rijen houden hun identiteit.** Een node die er nog staat houdt dezelfde vermelding tussen rondes,
  zodat alles wat eraan gekoppeld is gekoppeld blijft.

---

## Meldingen

**Meldingen** toont wat Velnox op dit moment ziet: een cluster dat het niet kan bereiken, een node
offline, een cluster zonder quorum, nodes die het oneens zijn over hun versie, Ceph ongezond,
Ceph-daemons op verschillende releases, en elke Ceph-vlag die aan staat.

Ze worden bij elke keer openen uit de inventarisatie afgeleid. Een melding verdwijnt dus zodra de
oorzaak weg is en kan nooit verouderd zijn — en er is geen bevestigen, geen onderdrukken en geen
notificatie. Dat is met opzet en staat in [Bekende hiaten](known-gaps.md): een opgeslagen melding
heeft een levenscyclus nodig, en een half gebouwde levert een scherm vol alarmen op dat niemand leest.

### `noout`, in het bijzonder

Zegt een Ceph-vlagmelding `noout`, lees hem dan. Met `noout` aan markeert Ceph een kapotte OSD niet
als out, dus een dode schijf leidt tot geen herverdeling en **niets wordt rood**. Het blijft vrijwel
altijd achter na onderhoud waarvan iemand is weggeroepen. Zet hem uit, tenzij er nu onderhoud loopt.

---

## Als er iets niet werkt

| Wat je ziet | Wat het meestal is |
|---|---|
| *Velnox kan … niet bereiken* | Een firewall tussen de Velnox-host en poort 8006, of DNS. De worker is de enige service die naar buiten verbindt. |
| *Dit lijkt geen Proxmox-API* | Juiste host, verkeerde poort — of een reverse proxy vóór Proxmox die antwoordt. |
| *Vingerafdruk komt niet overeen* | Het certificaat van de node is gewijzigd. Dat gebeurt legitiem bij vernieuwing of het opnieuw opbouwen van een node — en het is ook precies hoe onderschepping eruitziet. Controleer `pvenode cert info` op de node, verwijder daarna het cluster en voeg het opnieuw toe met de nieuwe vingerafdruk. Velnox accepteert een nieuw certificaat niet stilletjes voor je. |
| *Proxmox weigerde de credentials* | Het token is ingetrokken, of de privilege separation sluit uit wat Velnox leest. `PVEAuditor` op `/` is genoeg. |
| Een ronde met **Gedeeltelijk** | Open **Uitleesrondes**. Elk probleem staat er met de bijbehorende node bij. |

---

## Waar je hierna naartoe kunt

- [Je omgeving indelen](organising-your-fleet.md) — tenants, locaties en het beperken van een recht
- [Gebruikers en toegang beheren](managing-access.md) — accounts, rollen, tweede factor, Entra ID SSO
- [Bekende hiaten](known-gaps.md) — wat er op dit moment bewust ontbreekt
- [Architectuur](architecture.md) — hoe het systeem in elkaar zit, en waarom

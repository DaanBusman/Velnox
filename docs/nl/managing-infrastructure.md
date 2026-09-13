# Clusters toevoegen en de inventarisatie lezen

> **Vertaling.** Bron: [docs/managing-infrastructure.md](../managing-infrastructure.md) @ `b730a19`.
> **Engels is leidend.** Bij verschil tussen deze tekst en de Engelse versie geldt de Engelse tekst.

**Alles over het onder beheer brengen van Proxmox en weten wat er staat.** Elk hoofdstuk is één taak,
geschreven om te lezen terwijl je hem uitvoert.

Voor tenants en locaties, zie [Je omgeving indelen](organising-your-fleet.md). Voor accounts en
rollen, zie [Gebruikers en toegang beheren](managing-access.md).

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
   `PVEAuditor` op `/` als je het ook aan de Proxmox-kant alleen-lezen wilt houden. Velnox leest in
   deze fase alleen, dus `PVEAuditor` is genoeg en de betere keuze.
4. Kopieer het geheim. Proxmox toont het **één keer**.

Het token-id is de volledige tekst die Proxmox toont, realm inbegrepen: `root@pam!velnox`.

### Een aparte gebruiker is beter dan root

Maak `velnox@pve` aan, geef die `PVEAuditor` op `/`, en maak het token daarop. Dan kan een
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

### Een losse node

Precies dezelfde stappen. Eén node vormt geen cluster, en Velnox modelleert hem als een cluster van
één — hij verschijnt met de aanduiding **Losse node**, en wordt gerapporteerd als "geen quorum" in
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

Een cluster verwijderen verwijdert ook de opgeslagen credential. Een geheim zonder eigenaar is een
geheim dat niemand gaat roteren.

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

**Nodes**, **Virtuele machines**, **Containers**, **Opslag** en **Netwerken** tonen dezelfde gegevens
over alle clusters die je kunt zien, voor wanneer de vraag "waar staat die schijf" is in plaats van
"hoe gaat het met dit cluster".

### Cijfers die ontbreken, en cijfers die nul zijn

Een streepje betekent dat Velnox dat getal niet heeft. Een nul betekent dat het getal nul is. Dat
zijn verschillende feiten en de interface haalt ze nooit door elkaar — een opslag die geconfigureerd
is maar niet aangekoppeld toont streepjes, geen lege schijf.

---

## Uitlezen: wanneer het gebeurt, en wat er gebeurt als iets kapot is

Elk cluster wordt volgens schema uitgelezen, standaard elke 30 minuten. Wijzig dat per cluster op de
clusterpagina, of zet het op **Alleen op verzoek** om het schema voor één klant uit te zetten zonder
iemand anders te raken. **Nu uitlezen** start er meteen een.

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

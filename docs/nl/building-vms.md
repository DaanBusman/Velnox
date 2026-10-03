# VM's bouwen vanuit templates

> **Vertaling.** Bron: [docs/building-vms.md](../building-vms.md) @ `76ed14f`.
> **Engels is leidend.** Bij verschil tussen deze tekst en de Engelse versie geldt de Engelse tekst.

**Een template zegt wat een VM moet zijn; Velnox bouwt hem en ziet de installatie tot het eind.**
Windows installeert zichzelf vanaf zijn ISO met een antwoordbestand dat Velnox schrijft; Linux start
vanuit een cloud image en configureert zichzelf bij de eerste start. Niemand drukt op een toets, en
wie erom vroeg krijgt een mail als hij klaar is.

Wie wat mag, staat in [Rollen en rechten](permissions.md). Waarom het werkt zoals het werkt, staat in
ADR-039 in [Technologiekeuzes](tech-decisions.md). De installers en cloud images komen uit
[de ISO-bibliotheek](managing-the-library.md).

---

## Wat er eerst nodig is

- **De bestanden in de bibliotheek.** Een Windows-ISO, en de ISO met VirtIO-drivers
  (`virtio-win.iso`, van het Fedora-project) als het template VirtIO of de guest agent gebruikt. Voor
  Linux een cloud image: Ubuntu's `*-server-cloudimg-amd64.img` of Debians
  `*-genericcloud-amd64.qcow2`.
- **Opslag op de node** die `images` accepteert voor de schijven van de VM, en een die `iso` — en voor
  Linux `import` — accepteert voor de installer, het cloud image en de antwoord-cd. De opslag `local`
  accepteert `iso`; `import` moet daar worden aangezet onder *Datacenter → Storage* (Proxmox VE 8.2 of
  nieuwer).
- **Meer dan lezen voor het Proxmox-token.** Een VM bouwen schrijft naar het cluster. Het token heeft,
  zoals wij de rechten van Proxmox begrijpen — controleer ze tegen je versie — nodig:

  | Rol, op | Voor |
  |---|---|
  | `PVEAuditor` op `/` | de inventarisatie, zoals voorheen |
  | `PVEDatastoreUser` op `/storage` (of de gebruikte opslag) | installers en antwoord-cd's op opslag zetten, en ze verwijderen |
  | `PVEVMAdmin` op `/vms` (of een pool) | de VM maken, starten, configureren en vernietigen, en zijn guest agent |
  | `PVESDNUser` op `/sdn/zones/localnetwork` | de VM op een bridge aansluiten |

- **Uitgaande mail**, als er iemand moet worden gewaarschuwd — zie [Uitgaande mail](#uitgaande-mail).

---

## Templates

**Administratie → Autoconfig.** Een template is van de MSP of van één klant:

- Een **MSP-template** met *elke klant* wordt aan elke tenant aangeboden; met *alleen de eigenaar* is
  het voor MSP-medewerkers, die er nog steeds voor elke klant mee kunnen bouwen.
- Een **template van een klant** is alleen van die klant. Geen andere klant ziet het.

Een template zien is het niet wijzigen. Een klant kan bouwen vanuit een MSP-template, en het
**Klonen** om een eigen te maken die hij kan wijzigen; de kopie volgt het origineel daarna niet.

Templates wijzigen vraagt `autoconfig.manage` — op de MSP voor MSP-templates, op de tenant voor de
eigen templates van een klant.

### Wachtwoorden en codes

Het wachtwoord van elk account is een van:

- **Per VM gegenereerd** — de standaard en de aanbeveling. Elke VM krijgt zijn eigen, dus één
  uitgelekt verslag opent één machine.
- **Vast op dit template** — één keer getypt, versleuteld opgeslagen, voor elke VM gebruikt. Minstens
  twaalf tekens, met drie van hoofdletters, kleine letters, cijfers en symbolen, omdat Windows die
  regel tijdens Setup toepast, waar niemand het zou zien mislukken.
- **Geen** (Linux) — een account met alleen een sleutel.

Een opgeslagen wachtwoord of productcode wordt nooit meer getoond. Het template zegt *Opgeslagen*, en je
kunt het vervangen of verwijderen. **Een kloon neemt de opgeslagen wachtwoorden van het origineel niet
mee** — ze konden niet worden gekopieerd zonder ze te lezen, en die van een MSP horen niet zo bij een
klant te komen. De kloon noemt ze als ontbrekend tot ze zijn ingesteld, en kan tot dan niet bouwen.

### Windows

- **Installer en editie.** Kies de ISO; de genoemde edities zijn uit de ISO zelf gelezen, en Setup
  installeert die met precies die naam. Kon de lijst niet worden gelezen, dan wordt de naam getypt —
  en moet hij precies met de ISO overeenkomen, anders installeert Setup de eerste editie.
- **VirtIO-drivers en de guest agent.** Standaard aan. Ze installeren vanaf de VirtIO-ISO, en Velnox
  heeft de agent nodig om te zien dat de installatie klaar is.
- **GPT** wordt aangeraden en Windows 11 vereist het: de VM krijgt UEFI, Secure Boot-sleutels en een
  TPM.
- **Productcode.** Zonder code stopt Setup er niet voor; Windows vraagt er bij activering om als de
  editie er een nodig heeft.
- **Regio en taal** zijn vier instellingen, niet één: weergavetaal (een taal die de ISO heeft),
  systeemlandinstelling, notaties, toetsenbord. Nederlandse invoer op US-International is een eigen
  keuze. De tijdzone staat daar weer los van.
- **Accounts.** De ingebouwde Administrator krijgt altijd een wachtwoord — Windows Server vereist er
  een. Op een desktop-editie wordt hij na de eerste aanmelding uitgeschakeld, dus minstens één account
  hier moet een beheerder zijn.
- **Systeem.** Werkgroep, Extern bureaublad met zijn firewallregel, energiebeheer, sluimerstand, en of
  Windows Update tijdens Setup draait (een uur) of achteraf (minuten).

### Linux

- **Cloud image** en **distributie**.
- **Pakketmirror.** Aangeraden is het CDN van Debian (`deb.debian.org`) of de lijst van Ubuntu die op
  locatie kiest — nooit standaard één vaste server, want een vaste mirror is een single point of
  failure. Een nationale mirror wordt als keuze aangeboden; een APT-proxy kan worden ingesteld.
- **Accounts** zijn sudo-gebruikers; extra accounts zijn gebruikers, geen extra roots. **Publieke
  SSH-sleutels** één per regel. Aanmelden als root blijft uit tenzij je het aanzet, en dan meldt root
  zich alleen met een sleutel aan, tenzij aanmelden met wachtwoord ook is toegestaan.
- **De SSH-schakelaar**, standaard aan: de server geïnstalleerd en actief, de sleutels geplaatst,
  aanmelden met wachtwoord uit tenzij toegestaan, en poort 22 open waar het image een firewall draait.
- Landinstelling, toetsenbord en tijdzone, extra pakketten, een wisselbestand, automatische
  beveiligingsupdates.

### Hoe de wachtwoorden de aanvrager bereiken

- **Alleen in Velnox** — de standaard. De mail linkt naar de VM; de wachtwoorden worden in Velnox
  getoond.
- **In een versleutelde PDF** — de mail bevat het installatieverslag met de wachtwoorden, versleuteld
  met AES-256. Het wachtwoord daarvan staat **nooit in dezelfde mail**: het wordt één keer getoond aan
  wie de VM aanvraagt, direct na de aanvraag; of het is door een beheerder op het template ingesteld en
  wordt op een andere manier doorgegeven.

---

## Een VM bouwen

**Infrastructuur → Virtuele machines → Nieuwe VM** (of **VM bouwen** bij een template). Vraagt
`workloads.provision` op het cluster. Kies het cluster, een template dat aan zijn tenant wordt
aangeboden, de node, de opslag voor de schijven en voor de installer, de bridge en eventueel een VLAN,
een hostnaam — zonder domein; hoogstens 15 tekens voor Windows, waarvan de netwerknaam daar wordt
afgekapt — en DHCP of een vast adres.

Velnox weigert voordat er iets begint als iets niet kan: een template met ontbrekende geheimen, een
naam die een VM op het cluster al heeft, opslag die niet de juiste inhoud accepteert, een bridge die
de node niet heeft, een editie die de ISO niet heeft, een melding terwijl mail niet is ingesteld.

Daarna loopt het als een job die je kunt volgen en annuleren:

1. **Controle** dat de node online is en de opslag en bridge zijn wat het formulier zei.
2. **Media** — de installer of het cloud image wordt uit de bibliotheek naar de node gekopieerd als het
   er nog niet staat. Het blijft staan voor de volgende VM.
3. **Aanmaken** van de VM, met de hardware van het template.
4. **Antwoorden** — de wachtwoorden worden bepaald, het antwoordbestand wordt geschreven voor de
   netwerkkaart van deze VM, op een kleine cd gezet en gekoppeld.
5. **Starten** — voor Windows op UEFI wordt bij de opstartvraag op Enter gedrukt.
6. **Installatie** — Velnox wacht tot de guest agent het markeerbestand meldt dat het antwoordbestand
   als laatste schrijft. Tot drie uur voor Windows, vijfenveertig minuten voor Linux.
7. **Afronden** — de adressen worden gelezen, elke cd wordt uitgeworpen, en de antwoord-cd wordt van de
   opslag verwijderd. Die bevatte de wachtwoorden.
8. **Melden** — één keer, aan wie erom vroeg.

**Zolang het loopt, staat de VM bij Virtuele machines** met de status van de uitrol — in de wachtrij,
of wordt uitgerold met de stap waar hij is en hoe ver de job is — in plaats van de status van een gast.
De pagina ververst zichzelf tot er geen uitrol meer loopt. Is de VM klaar, dan staat hij er als elke
andere VM; een mislukte uitrol blijft een dag in de lijst, gemarkeerd als mislukt, met de registratie
één klik verder.

**Mislukt of geannuleerd: dan wordt de VM vernietigd** met zijn schijven, de antwoord-cd verwijderd en
worden de wachtwoorden niet bewaard. Kon Velnox de VM niet vernietigen, dan zegt de registratie dat met
het VM-ID — verwijder hem in Proxmox.

---

## Het verslag, en de wachtwoorden

**Uitrolgeschiedenis**, boven aan Virtuele machines, toont alles wat vanuit templates is gebouwd,
klaar of niet. Een registratie toont het template, cluster en node, het
VM-ID, de adressen die de gast meldde, wie het vroeg, hoe lang het duurde, en waarom het mislukte als
dat zo was.

**Wachtwoorden tonen**, voor wie dat cluster mag beheren (`clusters.manage`): elke keer wordt
vastgelegd in het auditlog — geweigerde pogingen ook — en de wachtwoorden verdwijnen na vijf minuten
van de pagina. Ze worden **dertig dagen** bewaard nadat de VM klaar is en daarna verwijderd; daarna
zegt de registratie dat ze niet meer worden bewaard. Wijzig ze daarvoor op de VM.

---

## Uitgaande mail

**Administratie → Uitgaande mail**, voor `system.manage`. In deze volgorde:

1. **Sla** de server **op**: host, poort, versleuteling, afzender, en een gebruikersnaam en wachtwoord
   als de server die vraagt. STARTTLS is verplicht als het is gekozen — een server die het niet biedt
   wordt geweigerd, niet onversleuteld gebruikt. *Geen* is alleen voor een relay op dezelfde host of in
   een lab.
2. **Verstuur een test.** De worker verstuurt hem, met de opgeslagen instellingen, zoals hij elke mail
   verstuurt.
3. **Zet mail aan.** Kan niet voordat er met deze instellingen een test is verstuurd; de server wijzigen
   zet mail weer uit tot de volgende test.

Het wachtwoord wordt nooit meer getoond.

---

## Waar het misgaat

| Wat je ziet | Wat het betekent |
|---|---|
| *Geheimen ontbreken* bij een template | Vaste wachtwoorden of een code die de instellingen vragen zijn niet opgeslagen — typisch voor een kloon. Open het en stel ze in. |
| *… heeft geen editie met de naam …* | Het template noemt een editie die de ISO niet heeft. Kies er een uit de lijst. |
| *Opslag … accepteert geen …-inhoud* | Zet het inhoudstype aan op de opslag in Proxmox, of kies een andere. |
| *Node … heeft geen bridge met de naam …* | Kies een bridge die op die node bestaat. |
| *Een VM op dit cluster heet al …* | Kies een andere hostnaam. |
| *Uitgaande mail is niet ingesteld* | Vink de mail uit, of laat een beheerder het instellen. |
| De job wacht lang bij **Installatie** | Open de console van de VM in Proxmox. Een Setup die bij een vraag stilstaat betekent dat het antwoordbestand die niet afdekte — meestal een weergavetaal die de ISO niet heeft. |
| *De installatie meldde zich niet binnen … minuten* | De guest agent antwoordde nooit: de VirtIO-ISO of de agent-schakelaar stond uit, of Setup stond stil. De VM is verwijderd. |
| *… kon niet worden verwijderd* | Verwijder de VM in Proxmox met het VM-ID op de registratie. |
| *De wachtwoorden van deze VM worden niet meer in Velnox bewaard* | Er zijn dertig dagen verstreken, of de bouw is mislukt. |

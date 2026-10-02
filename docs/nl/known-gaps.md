# Velnox — Bekende beperkingen

> **Vertaling.** Bron: [docs/known-gaps.md](../known-gaps.md) @ `2c5fd66`.
> **Engels is leidend.** Bij verschil tussen deze tekst en de Engelse versie geldt de Engelse tekst.

Dit bestand is het eerlijke grootboek. Alles wat Velnox niet doet, niet volledig doet, of met handmatige
tussenkomst doet, staat hier — en wordt nooit in de UI gepresenteerd als werkend.

Het wordt in **elke** fase bijgewerkt. Een fase die iets onvolledigs oplevert zonder vermelding hier,
heeft haar poort niet gehaald.

---

## Huidige status: fase 5B (VM's bouwen) — gebouwd, nog niet bewezen op een echt cluster

Aanmelden werkt. De installatiewizard maakt de eerste beheerder aan en sluit daarna permanent. Elk
API-endpoint dat niet bewust publiek is, vereist een sessie, en de globale guard beschermt
standaard: een nieuw endpoint is beschermd doordat het bestaat, en moet zich schriftelijk afmelden.

Klanten zijn echt: tenants, locaties, en rechten die benoemen wat ze dekken, met de scheiding
afgedwongen in de datalaag in plaats van onthouden door elk endpoint. Proxmox-clusters kunnen worden
toegevoegd tegen een bevestigde certificaatvingerafdruk, en hun nodes, gasten, opslag, netwerken en
Ceph worden volgens schema geïnventariseerd.

Werk dat tijd kost draait als **job**: een vastgelegde uitvoering met stappen, een live
gebeurtenissenstroom, annuleren op veilige punten, goedkeuringspunten met een optioneel
vierogenprincipe, en een dode worker die wordt opgemerkt en gemeld in plaats van bezig te blijven
lijken. Zie [Jobs volgen, annuleren en goedkeuren](working-with-jobs.md).

De **ISO-bibliotheek** bevat installers en cloud images op de Velnox-host, en kopieert ze naar de
opslag van een cluster en terug. Zie [De ISO-bibliotheek](managing-the-library.md).

**VM's worden vanuit templates gebouwd** — Windows onbeheerd vanaf zijn ISO, Linux vanuit een cloud
image — met hun wachtwoorden gegenereerd of versleuteld opgeslagen, alleen getoond via een vastgelegde
onthulling, en een mail als ze klaar zijn. Zie [VM's bouwen vanuit templates](building-vms.md).

**Die twee zijn het enige wat Velnox naar je infrastructuur schrijft:** bestanden op opslag, en
nieuwe VM's. Niets stopt, migreert, werkt bij of herconfigureert een bestaande node of gast.

Wat er **nog niet** is, op volgorde van hoe zwaar het weegt:

### Aanmelden met Microsoft Entra ID werkt nog niet
Het configuratiemodel, de validatie van het discovery-document en "verbinding testen" zijn echt: de
API haalt het discovery-document van de provider op, valideert het en legt vast wat er is
waargenomen. De authorization code + PKCE-flow waarmee iemand daadwerkelijk zou aanmelden, is niet
geschreven. `signInAvailable` staat in het API-antwoord op `false`, de aanmeldpagina toont geen
Microsoft-knop, en de instellingenpagina zegt het met zoveel woorden. Niets hier doet alsof het
werkt.

### Rollen worden aangemaakt, niet bewerkt
De zeven systeemrollen worden bij de installatie aangemaakt uit de bevroren catalogus in
`packages/shared`, en het scherm Rollen en rechten toont precies wat elke rol verleent. Er is geen
interface om een eigen rol te maken of te wijzigen welke rechten een rol heeft — dat komt met
multi-tenancy, waar een tenant-eigen rol pas iets heeft om zich toe te verhouden.

### Een wachtwoord zelf wijzigen kan niet
Een beheerder stelt het eerste wachtwoord van een account in en geeft dat buitenom door, omdat
Velnox geen e-mail verstuurt. Het account kan het daarna niet zelf wijzigen vanuit de interface:
`changePassword` bestaat in de service, dwingt de sterkte-eis af en trekt elke andere sessie in,
maar heeft nog geen endpoint.

### Gebruik van een herstelcode wordt gelogd, niet gemeld
Het gebruik van een herstelcode wordt naar het auditspoor geschreven en uitgestuurd als
`warn`-gebeurtenis met een vaste naam (`auth.mfa.recovery_code_used`), waarop de logpijplijn van een
beheerder vandaag kan alarmeren. Velnox heeft nog geen eigen meldingsafhandeling — geen e-mail, geen
webhook — dus het woord "gemeld" uit de roadmap wordt op dit moment ingevuld door het logboek, niet
doordat Velnox iemand benadert.

### De SSRF-bescherming bij discovery heeft een gat voor DNS-rebinding
Voordat de API een discovery-document ophaalt, vereist zij HTTPS, weigert zij redirects, en zoekt
zij de hostnaam op om te controleren dat het geen privé-, loopback-, link-local- of
cloud-metadata-adres is. Een naam die tussen die controle en het ophalen anders resolvet, zou er
doorheen glippen. Dat goed dichtzetten vereist een agent die aan het gecontroleerde adres is
vastgezet. Het endpoint is beperkt tot `system.manage`, het hoogste recht dat het product kent, en
de controle stopt elke rechttoe-rechtaan poging — waaronder `169.254.169.254` en interne
containernamen, beide geverifieerd.

### Er is geen sessieoverzicht en geen "overal afmelden"
Sessies roteren correct en een hergebruikt refresh-token trekt de hele familie in, maar een
gebruiker kan zijn actieve sessies niet zien of beëindigen vanuit de interface. Een
wachtwoordwijziging trekt al elke sessie in als neveneffect.

### De backend-image draagt zijn buildafhankelijkheden mee
`deploy/docker/backend.Dockerfile` kopieert de hele workspace, inclusief devDependencies, naar de
runtime-laag. pnpm's `node_modules` is een graaf van relatieve symlinks die het niet overleeft om
uit elkaar gehaald te worden, en een naïeve `pnpm prune --prod` zou de gegenereerde Prisma-client
verwijderen. Een fatsoenlijk afgeslankte runtime-image is verpakkingswerk voor fase 14, en daar
telt het omdat het onderdeel is van het artefactbudget van ~1 GB voor air-gapped installaties.

### De Content-Security-Policy staat nog `'unsafe-inline'` toe
Next.js zendt inline bootstrap-scripts en inline stijlen uit, en Swagger UI op `/api/docs` doet
hetzelfde. Dat vervangen door nonces per verzoek is hardening voor fase 15. De header is aanwezig en
elke andere beveiligingsheader is streng; deze ene specifieke versoepeling is echt en wordt niet
weggepoetst.

### Standalone-output staat standaard uit, om een Windows-reden
`next build` levert alleen `output: 'standalone'` op wanneer `VELNOX_STANDALONE=1`, wat de
Dockerfile zet. Tracing maakt symlinks, en Windows weigert dat zonder Ontwikkelaarsmodus — het altijd
aan laten staan zou betekenen dat een ontwikkelaar op Windows de app helemaal niet kan bouwen. De
image die wordt uitgeleverd is altijd de standalone-versie.

### Twee tellers op het dashboard zijn nog streepjes
Nodes met openstaande updates (fase 6) en upgradeblokkades (fase 9) tonen `—` met de fase die ze
vult. Het zijn geen plaatshouders voor verborgen gegevens en geen nullen die zich voordoen als
metingen. De andere zes tellen wat het aangemelde account kan zien. De servicestatus staat niet op
het dashboard: die staat in **Serverbeheer**, alleen zichtbaar voor een account met `system.manage`.

### Meldingen hebben geen levenscyclus
Het meldingenscherm toont condities die bij elke keer openen uit de inventarisatie worden berekend.
Dat is het geheel: geen bevestigen, geen onderdrukken, geen historie en geen notificatie — geen
e-mail, geen webhook, niets dat je bereikt wanneer je niet naar het scherm kijkt.

Bewust, en met opzet de kleinere helft van het probleem. Een opgeslagen melding heeft
gemeld / bevestigd / opgelost / opnieuw gemeld nodig, en een half gebouwde levenscyclus levert een
scherm vol verouderde alarmen op dat niemand leest — erger dan een scherm dat er eerlijk over is dat
het alleen weet wat er nú waar is. Ze bezorgen vereist een notificatiekanaal. Mail bestaat sinds fase 5B, maar alleen voor VM's die
klaar zijn; meldingen gebruiken het nog niet.

### Uitrol is bewezen tegen de fixture, nog niet tegen een echt cluster
`verify-provisioning.sh` doorloopt de hele stroom tegen de fixture-Proxmox: templates, de weigeringen,
de media naar de node gekopieerd, de VM gemaakt, de antwoord-cd gebouwd, gekoppeld, teruggelezen
zoals een gast hem leest, uitgeworpen en verwijderd, de mail, de onthulling, een mislukking en een
annulering opgeruimd. De fixture installeert niets. Dit is dus **nog niet gezien**:

- Windows Setup die onbeheerd draait vanuit het antwoordbestand — inclusief de Enter bij de
  UEFI-opstartvraag, VirtIO-drivers die tijdens Setup laden, de editie gekozen op naam, en een VM die
  bij activering om een productcode vraagt als er geen was opgegeven.
- cloud-init dat een echt cloud image configureert: sleutels die bij de eerste start werken en
  aanmelden met wachtwoord dat wordt geweigerd, de mirror, het wisselbestand. De uitvoer doorstaat de
  eigen schemacontrole van cloud-init; dat is niet hetzelfde.
- De Proxmox-aanroepen die de fixture op zijn eigen manier beantwoordt: `import-from` bij het maken,
  `sendkey`, het lezen van een bestand via de guest agent, en de rechten die een eigen token daarvoor
  nodig heeft.

Tot er van elk één op een echt cluster is gebouwd, is fase 5B gebouwd, niet af.

### De editielijst van een Windows-ISO is gelezen uit ISO's die voor de tests zijn gemaakt
De lijst wordt gelezen uit `install.wim` in het UDF-bestandssysteem van de ISO. Die lezer is bewezen
tegen ISO's gemaakt met genisoimage en wimlib, niet tegen een ISO van Microsoft. Kan er een niet worden
gelezen, dan zegt het formulier dat en wordt de editie getypt — ongecontroleerd.

### De antwoord-cd bevat wachtwoorden zolang de installatie loopt
De verborgen wachtwoorden van unattend zijn omkeerbaar, dus de antwoord-cd op de opslag van de node
bevat ze zolang Windows installeert. Hij wordt verwijderd als de job eindigt, hoe die ook eindigt;
sterft de worker midden in een installatie, dan blijft hij staan tot iemand hem verwijdert
(`velnox-answers-<id>.iso`).

### De wachtwoorden van een VM worden dertig dagen bewaard
Daarna worden ze verwijderd. De termijn is vast; er is nog geen instelling. Niets wijzigt ze op de VM.

### Mail is gewone SMTP, alleen bewezen tegen de mailsink van de fixture
STARTTLS en TLS gaan via nodemailer met certificaatcontrole, maar het harnas test alleen een
onversleutelde sink. Er is één melding — een VM is klaar — en nog geen voor meldingen uit de
inventarisatie.

### De versleuteling van het installatieverslag grijpt in pdfkit in
Revisie 6 wordt gezet door te herschrijven wat pdfkit voorbereidde, dus pdfkit staat vast op 0.20.2;
een nieuwere moet worden gecontroleerd voordat hij wordt overgenomen.

### De ISO-bibliotheek is bewezen tegen de fixture, nog niet tegen een echt cluster
Elke verplaatsing — pushen, terughalen, verwijderen, halverwege annuleren — wordt door
`verify-library.sh` uitgevoerd over echte sockets, tegen de Proxmox-API van de fixture en zijn
SFTP-server. Wat dat niet kan bewijzen is hoe een echte Proxmox drie dingen beantwoordt: de
multipart-uploadbody, uploaden naar `import`-inhoud, en het volumepad dat hij voor een bestand
opgeeft (dat het terughalen daarna via SFTP opent; de fixture beeldt het af op zijn eigen map). Alle
drie volgen de gepubliceerde API van Proxmox; geen ervan is tegen een echte node uitgevoerd.

### Disk-images vragen een Proxmox met `import`-inhoud
Cloud images gaan als `import`-inhoud op een opslag, een type dat Proxmox VE 8.2 introduceerde en dat
op een opslag aan moet staan. Een cluster op een oudere release, of zonder opslag die `import`
accepteert, krijgt geen opslag aangeboden voor een disk-image. ISO's hebben er geen last van.

### Een push waarvan de worker sterft, wordt op de node niet opgeruimd
Een geannuleerde of mislukte push verwijdert zijn half geschreven bestand van de node. Een push
waarvan de **worker sterft** kan dat niet: het opruimen sterft mee. De job wordt als verloren mislukt
en de bibliotheekkant wordt door de veger opgeruimd, maar niets gaat terug naar de node. Wat Proxmox
had ontvangen is na de volgende inventarisatie te zien op het tabblad **ISO's en images** van het
cluster, en kan daar worden verwijderd.

### De bibliotheek kan niet via een proxy ophalen
Ophalen van een URL maakt direct verbinding, zodat het gecontroleerde adres het adres is waarmee
verbinding wordt gemaakt. Een installatie die alleen via een HTTP-proxy naar buiten kan, kan niets van
internet ophalen; uploaden vanuit een browser werkt overal.

### Niets toetst een opgehaald bestand aan een gepubliceerde checksum
De SHA-256 van een bestand wordt onderweg naar binnen berekend en elke latere kopie wordt ertegen
gecontroleerd — maar bij aankomst heeft Velnox niets om hem mee te vergelijken. De checksum die een
leverancier naast een ISO publiceert wordt nog niet gevraagd; vergelijk hem met die de bibliotheek
toont.

### Hetzelfde bestand onder twee namen wordt twee keer opgeslagen
Bestanden zijn uniek op naam, niet op inhoud. Niets waarschuwt dat een nieuw bestand dezelfde
checksum heeft als een bestand dat er al staat.

### SSH wordt voor precies één ding gebruikt
Een bestand van een node kopiëren is het enige gebruik. `credentials` heeft nog een soort
`SSH_PASSWORD` die geen scherm aanbiedt — een sleutel is de enige manier om SSH in te stellen — en
credentialrotatie, die meer nodig heeft dan een bestand lezen, is fase 10.

### Updateaantallen zijn aantallen, geen classificatie
Een node meldt hoeveel pakketten apt zou installeren. Welke daarvan beveiligingsupdates zijn, welke
een herstart vereisen en welke van Proxmox zelf zijn, is het werk van fase 6, en de interface toont
alleen het getal dat het daadwerkelijk heeft in plaats van het in te kleuren.

### Uitlezen gebeurt periodiek, niet op signaal
Proxmox heeft geen gebeurtenissenstroom waarop Velnox zich kan abonneren, dus de inventarisatie is zo
vers als de laatste ronde — standaard 30 minuten. De interface behandelt dat als een feit in plaats
van het te verbergen: *laatst uitgelezen* is een kolom bij elk cluster, en een mislukte ronde laat de
vorige inventarisatie staan in plaats van hem te wissen.

### Eén credential per cluster
Een cluster draagt één API-token of wachtwoord, gebruikt voor elke node. Credentials per node zijn in
het schema gemodelleerd en worden niet aangeboden: geen enkele beheerder heeft erom gevraagd, en de
stroom voor het één voor één bevestigen van vijftien vingerafdrukken moet eerst ontworpen worden.

### Uitlezen draait nog niet op het jobsysteem
Fase 4 zei dat fase 5 drie dingen aan het uitlezen zou vervangen. Er is er één vervangen. Een cluster
toevoegen wacht nog steeds via een verzoekgebonden time-out op een workerjob, en uitleesrondes worden
nog steeds in een eigen tabel vastgelegd, zonder live voortgang en zonder annuleren — het jobsysteem
bestaat, en het uitlezen is er nog niet naartoe verhuisd. Dat gebeurt zodra het weer moet
veranderen, en uiterlijk met fase 6, waarvan de update-inventarisatie ernaast draait.

De derde is opgelost: een worker die halverwege het uitlezen werd gedood, liet de ronde voor altijd
als `RUNNING` achter. Dezelfde verzoening die verloren jobs laat mislukken, laat nu een uitleesronde
mislukken die na een uur nog loopt, met dezelfde reden `job.worker_lost`.

### De enige jobs zijn die van de bibliotheek, en een diagnostische
De vijf van de bibliotheek — ophalen, een upload controleren, naar een cluster kopiëren, van een
cluster kopiëren, op een cluster verwijderen — zijn de eerste jobs die echt werk doen.
`system.selftest` raakt niets aan en bestaat om het mechanisme te bewijzen. Updatebeheer (fase 6)
brengt de volgende.

### Jobgeschiedenis wordt voor altijd bewaard
Jobs, hun gebeurtenissen en hun uitvoer worden nooit verwijderd. Er is geen bewaarbeleid en geen
limiet naast 16 KiB per uitvoerregel. Met één gebeurtenis per voortgangsmelding wil een drukke
installatie er ooit een; de gebeurtenissentabel staat verwijderen om precies die reden toe, en
verbiedt alleen herschrijven.

### Een verloren job wordt pas na ongeveer een halve minuut opgemerkt
Een job waarvan de worker sterft, wordt op mislukt gezet met `job.worker_lost` zodra zijn lease
verloopt en een verzoening het merkt — gemeten op 33–34 seconden. Tot die tijd staat hij nog op
**Actief**. Zie ADR-035 voor waarom de lease niet korter is.

### Documentatiedrift is nu mogelijk
Fase 1 heeft twee besluiten uit fase 0 herzien (zie *Herzien in fase 1* in `architecture.md` en
`tech-decisions.md`). De Nederlandse vertalingen onder `docs/nl/` leggen vast van welke Engelse
commit ze zijn vertaald; `scripts/check-doc-sync.mjs` meldt welke zijn achtergebleven. Het
waarschuwt, het blokkeert niet.

### Opgelost in fase 5B
- **Velnox verstuurde geen mail.** Nu wel, via een server die een beheerder instelt en eerst met een
  test bewijst.
- **Er kon niets worden gebouwd.** VM's worden vanuit templates gebouwd, en een mislukte bouw laat geen
  VM achter.

### Opgelost in fase 5A
- **Er ging niets via SSH naar een node.** SSH bestaat nu, per cluster en optioneel, alleen voor
  leesacties via SFTP, met de host key van elke node bevestigd voordat er iets aan wordt aangeboden
  (ADR-038).
- **Velnox kon niets op een cluster zetten.** Het kopieert ISO's en cloud images naar opslag, en
  verwijdert ze, als jobs die niets achterlaten als ze worden geannuleerd.

### Opgelost in fase 5
- **De dashboardtellers waren streepjes, geen nullen**, ook voor gegevens die het product al sinds
  fase 3 had. Tegels waarvan de fase af is tonen nu echte aantallen, en linken naar het scherm erachter.
- **Het jobsysteem was een wachtrij, geen jobsysteem.** Het is nu een jobsysteem: vastgelegde
  uitvoeringen, een toestandsmachine die ongeldige overgangen weigert, live voortgang, annuleren,
  goedkeuringen en het opmerken van verlies.
- **Een worker die halverwege het uitlezen werd gedood liet de ronde voor altijd `RUNNING`.** Na een
  uur verzoend.

### Opgelost in fase 4
- **Het organisatiefilter bij Gebruikers had één keuze.** Er zijn nu klanttenants, het filter beperkt
  daartoe, en hetzelfde besturingselement staat in de bovenbalk en reist met je mee tussen pagina's.
- **De dashboardtellers zijn streepjes, geen nullen** — dat geldt nog steeds voor het dashboard zelf,
  dat werk voor fase 13 is, maar de inventarisatieschermen erachter zijn echt.
- **Tenantscheiding was een regel die elk endpoint onthield.** Het is nu een filter in de datalaag, en
  een bevraging zonder vastgesteld bereik gooit een fout in plaats van alles terug te geven (ADR-030).

### Opgelost in fase 2
- **Er is geen authenticatie.** Die is er nu. Elk niet-publiek endpoint vereist een sessie, en
  `scripts/verify-stack.sh` stelt vast dat anonieme aanroepers worden geweigerd.
- **`VELNOX_DEV_ENDPOINTS` stelt een diagnostisch endpoint bloot.** Het endpoint, de vlag en de
  dashboardkaart die hem aanriep zijn alle verdwenen. De controle erop in het acceptatiescript was
  stilletjes een permanente "skip" geworden; die is vervangen door controles die vaststellen dat
  authenticatie wordt afgedwongen.
- **Gebruikers zijn te bekijken, niet te beheren.** Accounts kunnen nu worden aangemaakt,
  uitgeschakeld en weer ingeschakeld, en rollen toegekend en ingetrokken — elk daarvan geaudit. Een
  account uitschakelen trekt zijn sessies direct in, in plaats van ze te laten doorlopen tot de
  tokens verlopen.
- **Het auditlogboek heeft geen interface.** Die is er nu, gepagineerd op cursor en gefilterd op de
  tenant en de rechten van de lezer zelf.
- **Een verlopen access-token wordt niet transparant vernieuwd.** Nu wel. Een openstaand tabblad
  vernieuwt zichzelf voordat de vijftien minuten om zijn, en een pagina die met een verouderd token
  wordt geladen vraagt de browser om het refresh-cookie in te wisselen in plaats van door te sturen
  naar het aanmeldscherm. Geverifieerd door een levend access-token ongeldig te maken en te
  herladen: de pagina kwam terug zonder iemand opnieuw te laten aanmelden.

---

## Bewuste uitsluitingen voor v1

Dit zijn beslissingen, geen omissies. Ze vallen buiten scope tenzij de opdrachtgever anders beslist.

| Gebied | Uitgesloten | Reden |
|---|---|---|
| Metrics | Langetermijnopslag en grafieken van tijdreeksen | Velnox legt inventaris en gezondheid op momentbasis vast; een TSDB is een ander product. Toekomst: Prometheus-integratie. |
| Back-ups | VM-back-ups beheren of opslaan | Proxmox Backup Server doet dit. Velnox kan PBS later orkestreren; het zal nooit VM-data opslaan. |
| PBS | Proxmox Backup Server als volwaardige inventaris | **Uitgesteld per beslissing (2026-08-31).** Het upgradeframework accepteert een PBS-playbook, en `upgrade_plans.kind` kent al de waarde `PBS`, maar er komt in v1 geen PBS-inventaris of -playbook. |
| Agent | Software op beheerde nodes installeren | Velnox is agentloos. Dat kost weerbaarheid tegen verbroken SSH-sessies (R-16) en is een bewuste afweging. |
| Portaal | Selfservice voor eindklanten | Tenant-gebruikers zijn in v1 operators, geen eindklanten. |
| Terugdraaien | Een voltooide Debian-hoofdupgrade terugdraaien | Technisch niet betrouwbaar mogelijk. Velnox meldt dit vóór de operator bevestigt en vereist een gedocumenteerde back-up als voorwaarde. |

---

## Verwachte gedeeltelijke implementaties (te bevestigen wanneer elke fase landt)

Deze worden nu al gemarkeerd zodat niemand later verrast wordt. Elk wordt in de eigen fase opnieuw bekeken
en precies gemaakt.

### Hyper-V schijfoverdracht — *met handmatige stap* (Phase 12)
Discovery, compatibiliteitsbeoordeling en planning zijn geautomatiseerd. De VHDX-overdrachtsstap vereist
netwerkpaden (SMB of SSH van de appliance naar de Hyper-V-host of diens opslag) die veel omgevingen niet
verlenen. In v1 is die stap in de UI gelabeld als handmatige tussenkomst en meldt hij pas succes nadat
Velnox het resulterende bestand zelf heeft geverifieerd — nooit uit zichzelf.

### VMware-overdracht — *afhankelijk van de PVE-doelversie* (Phase 11)
Velnox orkestreert de eigen ESXi-import storage van Proxmox VE, beschikbaar vanaf PVE 8.2. Op oudere
clusters levert Velnox discovery, compatibiliteitsbeoordeling en een gedocumenteerde handmatige procedure —
en zegt dat in de UI in plaats van een besturingselement aan te bieden dat niet kan werken.

### ISO-bouw — *alleen op een Linux-host* (Phase 14)
`live-build` vereist loop devices en verhoogde rechten. ISO-bouwen werkt niet op Docker Desktop voor
Windows of macOS. `build.sh --target iso` controleert vooraf en faalt met een duidelijke melding in plaats
van een niet-opstartbaar plaatsvervangend bestand te maken. De tar.gz- en zelfuitpakkende-installerdoelen
kennen die beperking niet.

### PostgreSQL Row-Level Security — *uitgesteld naar Phase 15*
Tenant-isolatie in Phase 3–14 wordt afgedwongen door de Prisma-tenancy-extensie plus RBAC-guards plus
CI-blokkerende cross-tenant tests. RLS is een vierde laag, uitgesteld omdat het elke query in een expliciete
transactie dwingt. Hier vastgelegd in plaats van stilzwijgend overgeslagen.

### Backends voor de secret store — *alleen database in v1*
`SecretStore` is een interface met `put`/`get`/`delete`/`rewrap`. Alleen `DatabaseSecretStore` wordt
geleverd. HashiCorp Vault- en Azure Key Vault-backends zijn voorzien maar niet geïmplementeerd, waardoor
`MASTER_ENCRYPTION_KEY` een enkel faalpunt is (R-05).

### Meervoudige authenticatie — *alleen TOTP; WebAuthn uitgesteld*
**Nu in scope (2026-08-31): optioneel maar aanbevolen.** TOTP met herstelcodes wordt in Phase 2 geleverd,
met de beleidsniveaus `OPTIONAL` / `REQUIRED_FOR_PRIVILEGED` / `REQUIRED` en `OPTIONAL` als standaard.
WebAuthn/passkeys zijn **niet** geïmplementeerd — `user_mfa_factors.kind` reserveert de waarde. TOTP is
eerst gekozen omdat het de factor is die nog werkt voor een noodtoegangsaccount op een onverwachte machine
tijdens een incident.

### Ceph — *upgrades in scope; automatisch herstel niet*
**Nu in scope (2026-08-31):** Ceph-inventaris (Phase 4) en Ceph major upgrades als eigen playbook,
samengesteld vóór de PVE-upgrade (Phase 9A). Wat Velnox **niet** doet: een beschadigd Ceph-cluster
repareren. Keert de gezondheid niet terug, dan stopt de uitvoering en wordt er gerapporteerd — er wordt geen
automatisch herstel geprobeerd, omdat dat expertwerk is waarbij een verkeerde automatische actie de zaak
verergert.

### Nederlandse documentatie — *drift is mogelijk*
Engels onder `docs/` is canoniek; `docs/nl/` is een vertaling. CI *waarschuwt* wanneer een Engelse bron is
gewijzigd sinds de Nederlandse tegenhanger vertaald werd, maar blokkeert niet — Engelse documentatie wordt
nooit opgehouden door een openstaande vertaling. Een Nederlands document kan dus achterlopen. Elk bestand
vermeldt de bron-commit waaruit het vertaald is, zodat een lezer dat kan zien. Voor UI-teksten geldt een
strengere regel: een ontbrekende of overtollige sleutel laat de build **falen**.

### Bronaanbod uit AGPL artikel 13 — *afhankelijk van de operator*
Velnox levert het mechanisme (`GET /api/v1/system/source`, Instellingen → Over, `VELNOX_SOURCE_URL`, de
ingesloten build-commit). Een operator die een **aangepaste** build draait moet die variabele naar de eigen
bijbehorende broncode laten wijzen. Velnox kan niet verifiëren dat dat gebeurd is — geen enkele software
kan dat. De verplichting is van hen; het mechanisme is van ons.

### Subtenants — *schema is voorbereid, niet geïmplementeerd*
`tenants.parent_tenant_id` bestaat zodat hiërarchische tenants mogelijk blijven, maar v1 ondersteunt precies
één niveau klanttenants onder de MSP-hoofdtenant.

---

*De naam en het logo van Velnox worden gebruikt door The Velnox Foundation. Er is geen merk geregistreerd of geclaimd; de AGPLv3 verleent daar geen rechten op.*

# Velnox — Bekende beperkingen

> **Vertaling.** Bron: [docs/known-gaps.md](../known-gaps.md) @ `2c2bcd1`.
> **Engels is leidend.** Bij verschil tussen deze tekst en de Engelse versie geldt de Engelse tekst.

Dit bestand is het eerlijke grootboek. Alles wat Velnox niet doet, niet volledig doet, of met handmatige
tussenkomst doet, staat hier — en wordt nooit in de UI gepresenteerd als werkend.

Het wordt in **elke** fase bijgewerkt. Een fase die iets onvolledigs oplevert zonder vermelding hier,
heeft haar poort niet gehaald.

---

## Huidige status: fase 2 (authenticatie, installatie, RBAC)

Aanmelden werkt. De installatiewizard maakt de eerste beheerder aan en sluit daarna permanent. Elk
API-endpoint dat niet bewust publiek is, vereist een sessie, en de globale guard beschermt
standaard: een nieuw endpoint is beschermd doordat het bestaat, en moet zich schriftelijk afmelden.

Wat er **nog niet** is, op volgorde van hoe zwaar het weegt:

### Aanmelden met Microsoft Entra ID werkt nog niet
Het configuratiemodel, de validatie van het discovery-document en "verbinding testen" zijn echt: de
API haalt het discovery-document van de provider op, valideert het en legt vast wat er is
waargenomen. De authorization code + PKCE-flow waarmee iemand daadwerkelijk zou aanmelden, is niet
geschreven. `signInAvailable` staat in het API-antwoord op `false`, de aanmeldpagina toont geen
Microsoft-knop, en de instellingenpagina zegt het met zoveel woorden. Niets hier doet alsof het
werkt.

### Gebruikers zijn te bekijken, niet te beheren
`GET /api/v1/users` is echt en wordt op rechten gecontroleerd. Een gebruiker uitnodigen, een rol
toewijzen, een account deactiveren en de rechten van een rol bewerken hebben nog geen endpoints —
die komen bij het rollenscherm. De gebruikerspagina zegt dat, in plaats van knoppen te tonen die
niets doen.

### Rollen worden aangemaakt, niet bewerkt
De zeven systeemrollen worden bij de installatie aangemaakt uit de bevroren catalogus in
`packages/shared`. Er is geen interface om een eigen rol te maken of te wijzigen welke rechten een
rol heeft.

### Het auditlogboek heeft geen interface
Elke authenticatie- en autorisatiegebeurtenis wordt weggeschreven, de tabel weigert UPDATE en DELETE
op databaseniveau, en de gebeurtenissen kloppen. Er is geen pagina om ze te lezen: vandaag is dat
`psql`. De sectie Auditlogboek in de zijbalk is gemarkeerd met de fase die haar invult.

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

### De tellers op het dashboard zijn streepjes, geen nullen
Tenants, clusters, nodes en de rest tonen `—` met de fase die ze zal vullen. Het zijn geen
plaatshouders voor verborgen gegevens en geen nullen die zich voordoen als metingen. De ene kaart
met echte gegevens is de servicestatus, en die is live.

### Documentatiedrift is nu mogelijk
Fase 1 heeft twee besluiten uit fase 0 herzien (zie *Herzien in fase 1* in `architecture.md` en
`tech-decisions.md`). De Nederlandse vertalingen onder `docs/nl/` leggen vast van welke Engelse
commit ze zijn vertaald; `scripts/check-doc-sync.mjs` meldt welke zijn achtergebleven. Het
waarschuwt, het blokkeert niet.

### Opgelost in fase 2
- **Er is geen authenticatie.** Die is er nu. Elk niet-publiek endpoint vereist een sessie, en
  `scripts/verify-stack.sh` stelt vast dat anonieme aanroepers worden geweigerd.
- **`VELNOX_DEV_ENDPOINTS` stelt een diagnostisch endpoint bloot.** Het endpoint, de vlag en de
  dashboardkaart die hem aanriep zijn alle verdwenen. De controle erop in het acceptatiescript was
  stilletjes een permanente "skip" geworden; die is vervangen door controles die vaststellen dat
  authenticatie wordt afgedwongen.

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

*Velnox™ is een handelsmerk van The Velnox Foundation.*

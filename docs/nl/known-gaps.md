# Velnox — Bekende beperkingen

> **Vertaling.** Bron: [docs/known-gaps.md](../known-gaps.md) @ `5b3fb43`.
> **Engels is leidend.** Bij verschil tussen deze tekst en de Engelse versie geldt de Engelse tekst.

Dit bestand is het eerlijke grootboek. Alles wat Velnox niet doet, niet volledig doet, of met handmatige
tussenkomst doet, staat hier — en wordt nooit in de UI gepresenteerd als werkend.

Het wordt in **elke** fase bijgewerkt. Een fase die iets onvolledigs oplevert zonder vermelding hier,
heeft haar poort niet gehaald.

---

## Huidige status: fase 1 (basis)

De stack draait: zes services, database, wachtrij, lokalisatie, licentienaleving. Wat er **nog niet**
is, op volgorde van hoe zwaar het weegt:

### Er is geen authenticatie. Helemaal niet.
Elk endpoint is niet-geauthenticeerd en elke pagina is publiek. Authenticatie, RBAC en multi-tenancy
komen in fase 2 en 3. **Zet een fase 1-build niet op een netwerk dat je niet volledig beheert.** De API
zegt dat bij het opstarten, en het dashboard zegt het tegen iedereen die het opent.

### `VELNOX_DEV_ENDPOINTS` stelt een diagnostisch endpoint bloot
De zelftest van de wachtrij (`POST /api/v1/system/selftest/queue`) bestaat om aan te tonen dat de
worker ingediend werk uitvoert. Hij raakt geen beheerde infrastructuur aan en geeft niets gevoeligs
terug, maar hij is net zo onbeschermd als de rest van deze build. Standaard staat hij uit in
`.env.example`; de vlag en het endpoint verdwijnen beide in fase 2.

### De backend-image draagt zijn buildafhankelijkheden mee
`deploy/docker/backend.Dockerfile` kopieert de hele workspace, inclusief devDependencies, naar de
runtime-laag. De `node_modules` van pnpm is een graaf van relatieve symlinks die niet overleeft dat je
hem uit elkaar haalt, en een naïeve `pnpm prune --prod` zou de gegenereerde Prisma-client verwijderen.
Een echt afgeslankte runtime-image is verpakkingswerk voor fase 14, en daar telt het ook, want het is
onderdeel van het budget van circa 1 GB voor het air-gapped artefact.

### De Content-Security-Policy staat nog `'unsafe-inline'` toe
Next.js zendt inline bootstrap-scripts en inline stijlen uit, en Swagger UI doet hetzelfde. Dat
vervangen door nonces per request is hardening voor fase 15. De header staat er en elke andere
security header is strikt; deze ene versoepeling is echt en wordt niet weggemoffeld.

### Standalone-output staat aan via een vlag, om een Windows-reden
`next build` levert alleen `output: 'standalone'` wanneer `VELNOX_STANDALONE=1`, wat de Dockerfile
zet. Tracing maakt symlinks aan, en Windows weigert dat zonder Developer Mode — het altijd aanzetten
zou betekenen dat een ontwikkelaar op Windows de app niet kan bouwen. De image die uitgeleverd wordt is
altijd de standalone versie.

### De dashboardtellers zijn streepjes, geen nullen
Tenants, clusters, nodes en de rest tonen `—` met de fase die ze gaat vullen. Het zijn geen
plaatshouders voor verborgen gegevens en geen nullen die zich voordoen als metingen. De enige kaart met
echte data is servicestatus, en die is live.

### Documentatiedrift is nu mogelijk
Fase 1 heeft twee keuzes uit fase 0 gewijzigd (zie *Gewijzigd in fase 1* in `architecture.md` en
`tech-decisions.md`). De Nederlandse vertalingen onder `docs/nl/` leggen de Engelse commit vast waaruit
ze vertaald zijn; `scripts/check-doc-sync.mjs` meldt welke zijn achtergebleven. Het waarschuwt, het
blokkeert niet.

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

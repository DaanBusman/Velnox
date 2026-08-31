# Velnox — Bekende beperkingen

> **Vertaling.** Bron: [docs/known-gaps.md](../known-gaps.md) @ `5fd136a`.
> **Engels is leidend.** Bij verschil tussen deze tekst en de Engelse versie geldt de Engelse tekst.

Dit bestand is het eerlijke grootboek. Alles wat Velnox niet doet, niet volledig doet, of met handmatige
tussenkomst doet, staat hier — en wordt nooit in de UI gepresenteerd als werkend.

Het wordt in **elke** fase bijgewerkt. Een fase die iets onvolledigs oplevert zonder vermelding hier,
heeft haar poort niet gehaald.

---

## Huidige status: Phase 0 (alleen ontwerp)

**Alles is een beperking.** Er is geen applicatiecode. De repository bevat uitsluitend
architectuurdocumenten. Er valt niets te installeren, te starten of te gebruiken.

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

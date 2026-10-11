# Grote upgrades

> **Vertaling.** Bron: [docs/major-upgrades.md](../major-upgrades.md) @ `f1de7a0`.
> **Engels is leidend.** Bij verschil tussen deze tekst en de Engelse versie geldt de Engelse tekst.

**Plannen die een cluster doel voor doel upgraden, de controles vooraf, de herstelacties, en het
rapport erna.** Een plan draait één playbook — een Ceph-upgrade, een Proxmox VE-upgrade — of, als
*samengesteld* plan, meerdere plannen na elkaar: eerst Ceph, dan Proxmox VE. De playbooks voor Ceph en
Proxmox VE komen in fase 9A en 9B; tot dan zijn de enige playbooks de eigen zelftests van de engine,
die niets buiten Velnox veranderen.

Voor wie wat mag, zie [Rollen en rechten](permissions.md). Voor waarom het zo werkt, zie ADR-050 in
[Technische beslissingen](tech-decisions.md).

---

## Plannen

**Beheer → Updates & upgrades**, tabblad **Grote upgrades** — ook op `/major-upgrades`. **Nieuw
plan**: een cluster, een playbook en een naam. De doelen komen uit de inventaris als het plan wordt
gemaakt, in de volgorde waarin ze geüpgraded worden: nodes op naam; Ceph-daemons in de eigen
volgorde van Ceph — monitors, dan managers, OSD's, MDS en RGW.

Een plan dat nog niet gedraaid heeft, kan gestart of verwijderd worden. Eenmaal gestart kan het niet
opnieuw gestart of verwijderd worden: zijn vastlegging en zijn rapport blijven.

---

## Hoe een plan draait

Elk playbook gaat door dezelfde fasen, als één job die je stap voor stap kunt volgen:

1. **Discovery** — wat de guards lezen: het quorum van het cluster, nodes die offline zijn, de
   versies van Proxmox VE, de gezondheid van Ceph.
2. **Preflight** — de controles van het playbook, elke bevinding `PASS`, `INFO`, `WARNING`,
   `BLOCKER` of `UNKNOWN`. Een regel die Velnox niet herkent is `UNKNOWN`, en houdt de upgrade tegen
   als een blokkade: hij wordt nooit onschuldig verondersteld. Een stap kan een *guard* hebben — een
   voorwaarde zoals "het cluster heeft quorum en geen node is offline" — die de run stopt, met wat er
   niet klopte.
3. **Herstel** — een bevinding met een herstelactie krijgt die, gerouteerd naar wat de herstelactie
   is:
   - **Door Velnox toegepast** als het risico laag is en Velnox het ongedaan kan maken.
   - **Vraagt goedkeuring** anders. De job stopt en wacht op iemand met `upgrades.execute` en
     `jobs.approve`, en toont de exacte wijziging — elk bestand regel voor regel, elk pakket, elke
     opdracht. Wat goedgekeurd wordt, is wat wordt toegepast: dezelfde vastlegging.
4. **Opnieuw controleren** — de controles draaien opnieuw. Het plan bewaart elke run, dus wat een
   herstelactie verhielp is een vergelijking, geen gok. Staat er nog iets open dat de upgrade
   tegenhoudt, dan eindigt de run hier, als **geblokkeerd**, voordat een doel is aangeraakt.
5. **Upgrade** en **validatie** — doel voor doel: het ene wordt geüpgraded en gevalideerd voordat het
   volgende begint. Een doel dat mislukt, stopt de run daar; de doelen ervoor zijn klaar, de doelen
   erna niet bereikt.
6. **Rapport** — de toestand van elk doel voor en na, wat elke controlerun vond, wat verholpen is en
   wat nog openstaat, elke herstelactie en hoe die afliep. Getoond bij het plan en te downloaden als
   Markdown, voor een ticket of een klant.

---

## Samengestelde plannen

Een samengesteld plan draait zijn plannen op volgorde, elk als eigen job: het volgende begint als het
vorige voltooid is en het cluster vrij is. Als er een mislukt — of geblokkeerd raakt — mislukt het
samengestelde plan, en worden de plannen erna geannuleerd zonder te starten. Zijn rapport bevat de
rapporten van zijn plannen, op volgorde.

Een plan binnen een samengesteld plan wordt niet los gestart; start het samengestelde plan.

---

## De zelftests

Twee playbooks bewijzen de engine op elk cluster, aangeboden aan wie de installatie beheert
(`system.manage`): één node voor node, één Ceph-daemon voor daemon. Ze werken op een vastlegging in het
plan en veranderen niets buiten Velnox: een ontbrekende markering op elk doel die Velnox zelf
verhelpt, een configuratie die goedkeuring vraagt om te wijzigen, een blokkade die niets verhelpt, een
doel dat mislukt — gekozen als het plan wordt gemaakt.

---

## Waar het misgaat

| Wat je ziet | Wat het betekent |
|---|---|
| *Een voorwaarde voor deze stap klopt niet: …* | Een guard — bijvoorbeeld een node die offline is. Maak het cluster heel en maak dan een nieuw plan. |
| *… houden de upgrade nog tegen* | Na herstel staat er nog een blokkade of een onbekende regel open. Het plan zegt welke. |
| *… herstelactie … is mislukt* | Een herstelactie kon niet worden toegepast, of verhielp haar controle niet. De uitvoer van de job zegt waarom. |
| *De upgrade van … is mislukt* | De upgrade of de validatie van een doel mislukte. De doelen ervoor zijn klaar. |
| *Alleen een plan dat nog niet gedraaid heeft, kan gestart of verwijderd worden* | Maak een nieuw plan. |
| *Er is geen playbook …, of het wordt jou niet aangeboden* | Zelftests vragen `system.manage`. |

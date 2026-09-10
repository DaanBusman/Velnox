# Velnox — trademark filing dossier

**Status: prepared, not filed.** Everything here is ready to submit; the filing itself, the fee and
the choice of applicant are decisions and actions for the owner.

This is not product documentation and is deliberately not bundled into the application — it is not
in the `DOCUMENTS` list in `apps/web/scripts/build-docs.mjs`.

---

## Why a registration is wanted

[TRADEMARK.md](../TRADEMARK.md) already asserts **Velnox™** as an unregistered mark, and
[NOTICE](../NOTICE) now declines to license it under AGPLv3 section 7(e). Both are worth having and
neither is a registration.

The distinction matters in practice. An unregistered mark in the Benelux gives you almost nothing:
unlike the UK or the US, the Benelux has **no protection for unregistered trademarks** — rights come
from registration, not from use. Until it is filed, "Velnox™" is a statement of intent, and the
first party to register the name owns it, potentially against you.

That is the whole argument for filing: the AGPLv3 lets anyone fork and rename, and the licence terms
in NOTICE make them keep attributing you. The trademark is what stops someone using *your* name.
Together those are the two halves of "you may not sell my software as your own".

---

## Before anything else: who is the applicant?

**This is the open question and it blocks the filing.**

An application needs a real applicant — a natural person or a registered legal entity. Every file in
this repository attributes the marks and the copyright to **"The Velnox Foundation"**. If that
entity does not legally exist, it cannot own a trademark, and filing in its name is at best void and
at worst a problem later when the ownership is examined.

Three options:

| Option | What it means |
|---|---|
| **File personally** | Applicant is the individual. Simplest, cheapest, works today. The mark can be assigned to an entity later. |
| **Incorporate first** | A Dutch foundation (*stichting*) or BV, then file in its name. Cleaner if the project is to have a legal life of its own, and it is what the copyright notices already claim. |
| **Change the notices** | If no entity is intended, the ~40 files claiming "The Velnox Foundation" should say the individual's name instead. |

The third is not really an option so much as a consequence: whichever of the first two is chosen,
the notices in the repository must end up naming the actual holder. They currently name an entity
whose existence has not been established here.

---

## What is already out there

Searched September 2026, on the open web only — see the limits section below.

| Name | What it is | Relevance |
|---|---|---|
| **Velnox Tech** | Operational software for business management: workforce scheduling, facility maintenance, compliance tracking | **The one that matters.** Same broad field as Velnox, so the same classes |
| Velnox Ltd (UK) | Retail of electrical goods and clothing, incorporated Nov 2024 | Different field; unlikely to conflict in class 9/42 |
| Velnox Solutions, Inc. (New York) | Incorporated Nov 2025 | US entity, unknown field |
| Velnox (Australia) | Outdoor LED lighting | Different field |
| Velnox Studio | Product video production | Different field |

**"Velnox" is not a unique name.** At least five entities use it. Most are in fields far enough away
to coexist, but Velnox Tech is in operational business software, which is where a Velnox application
in classes 9 and 42 would sit. That is a genuine conflict risk and it is the single most important
thing on this page.

None of these is necessarily a *registered trademark* — a company-register entry is not a mark. But
an earlier user in the same field can oppose an application and, depending on jurisdiction and
priority, can be a problem even without one.

### What was checked, and what was not

Checked: open web search for the name, company registers surfaced by it.

**Not checked, and this matters:** the EUIPO and BOIP trademark registers themselves. Those are
database applications that a web search does not index, so the absence of a "Velnox" registration in
the results above is **not evidence that none exists**. A real clearance search means:

- [EUIPO eSearch plus](https://www.euipo.europa.eu/en/trade-marks/before-applying/searches) for EU
  marks
- [BOIP trademarks register](https://www.boip.int/en/trademarks-register) for Benelux marks
- [TMview](https://www.tmdn.org/tmview/) for both plus national registers

All three are free to search. Doing that before paying a filing fee is the obvious next step, and a
trademark attorney's clearance opinion before filing in a contested field is cheap relative to
losing the application.

---

## What to file

### The mark

**VELNOX**, as a **word mark**. Word marks protect the name in any typeface, which is what is wanted
here; a figurative mark would protect the logo as drawn and would not stop someone using the name in
plain text.

A separate figurative filing for the logo can follow later if there is one worth protecting. The
name is the asset.

### The classes

Nice classification, edition in force at filing. Two classes cover what Velnox actually is:

**Class 9 — the software itself**

> Computer software for the management, monitoring and administration of virtualisation
> infrastructure and computer servers; computer software for managed service providers; downloadable
> computer software for infrastructure inventory, update management, migration and credential
> management; computer software for identity and access management.

**Class 42 — the service around it**

> Software as a service (SaaS) featuring software for the management and monitoring of virtualisation
> infrastructure; design, development, installation, maintenance and updating of computer software;
> technical support services relating to computer software; consultancy in the field of computer
> infrastructure management.

Class 42 is worth including even though Velnox is self-hosted rather than a SaaS: it covers
development, maintenance and support, which is what the Foundation actually provides.

**Not** class 35 (business management services) or class 38 (telecommunications). Neither describes
what this is, and unused classes cost money and can be attacked for non-use after five years.

### Where

| Route | Covers | Fee (one class) | Extra class |
|---|---|---|---|
| **BOIP** (Benelux) | Netherlands, Belgium, Luxembourg | €240 | €27 |
| **EUIPO** | All 27 EU member states | €850 | €50 (2nd), €150 (3rd+) |

For two classes: roughly **€267 Benelux**, **€900 EU**.

**Recommendation: start with BOIP.** It is the home market, it is a quarter of the price, and it
establishes a priority date. Under the Paris Convention, an EU or international application filed
within **six months** of it claims that earlier date — so a Benelux filing now does not close the EU
door, it holds it open cheaply while you find out whether the wider registration is worth it.

The counter-argument, worth weighing: if Velnox is intended to be sold across the EU from the start,
EUIPO in one step avoids paying twice and avoids a Benelux mark that is worthless against a German
competitor. Given the Velnox Tech conflict, there is also an argument for finding out early whether
the name survives an EU examination at all.

---

## After filing

- Change **™** to **®** in `TRADEMARK.md`, `NOTICE`, the About screen and the footer of every
  document — but only after registration. Using ® before then is a false claim and in some
  jurisdictions an offence.
- Record the registration number and date in `TRADEMARK.md`.
- Renew every ten years. Diarise it; a lapsed mark is worse than none, because the lapse is public.
- Use the mark, and keep evidence. A Benelux or EU mark unused for five consecutive years can be
  revoked for non-use by anyone who wants the name.

---

## The honest summary

Filing is cheap, quick, and the only thing that gives the name any protection in the Benelux at all.
The obstacles are not the cost:

1. **The applicant does not obviously exist.** Resolve that first.
2. **The name is crowded, and one of the other users is in software.** Search the actual registers
   before paying, and consider an attorney's opinion given that.

Neither is a reason not to file. Both are reasons not to file blind.

*Not legal advice. Prepared as groundwork for a decision that should be taken with a trademark
attorney, particularly given the conflict noted above.*

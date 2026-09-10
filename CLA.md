# Velnox Contributor Licence Agreement

**You keep the copyright in what you write.** This agreement asks you to grant The Velnox Foundation
a licence to it — it does not ask you to sign it over.

Signing is required before a contribution can be merged. The reason is set out at the bottom; read
that first if you want to know what you are agreeing to and why it is asked.

---

## Agreement

By submitting a contribution to Velnox — a pull request, a patch, or any other change to this
repository — you agree to the following, for that contribution and every contribution you make
afterwards.

### 1. Definitions

**"You"** means the individual or legal entity submitting the contribution. If you are contributing
on behalf of an employer, see section 7.

**"Contribution"** means any work of authorship you submit for inclusion in Velnox, including code,
documentation, translations, configuration and test material, and any modification to existing
material.

**"The Foundation"** means The Velnox Foundation, the copyright holder of Velnox.

### 2. Copyright licence

You retain ownership of your contribution. You grant The Foundation a perpetual, worldwide,
non-exclusive, royalty-free, irrevocable licence to reproduce, prepare derivative works of, publicly
display, publicly perform, sublicense and distribute your contribution and derivative works of it.

This licence includes the right to distribute your contribution **under the AGPLv3 and under other
licence terms**, including commercial terms. Section 8 explains why that matters and what it does
not allow.

### 3. Patent licence

You grant The Foundation and every recipient of Velnox a perpetual, worldwide, non-exclusive,
royalty-free, irrevocable patent licence to make, use, sell, offer to sell, import and otherwise
transfer your contribution, covering only those patent claims you can license that are necessarily
infringed by your contribution alone or by its combination with Velnox.

If you institute patent litigation alleging that Velnox or a contribution to it infringes a patent,
the patent licences granted to you under this agreement terminate on the date that litigation is
filed.

### 4. You have the right to grant this

You represent that:

- Each contribution is your original work, or you have the right to submit it under this agreement.
- Your contribution does not knowingly infringe anyone's copyright, patent, trademark or trade
  secret.
- If your contribution includes material you did not write, you have identified it, its source and
  its licence, in the contribution itself.

### 5. No obligation, and no warranty

The Foundation is under no obligation to accept, merge or keep any contribution. You provide your
contribution **as is**, without warranty of any kind. You are not expected to provide support for it.

### 6. Your other rights are untouched

You may use, publish and license your contribution however else you wish. This agreement is a grant
in addition to what you keep, not a transfer of it.

### 7. Contributing for an employer

If your employer has rights to work you produce — which is the default in most employment contracts
— then either your employer must agree to this document, or you must have written permission from
them to contribute. Say so in your pull request if this applies to you.

### 8. Why this is asked, and what it does not allow

**Why.** The Foundation is the sole copyright holder of Velnox today, which means it can offer
Velnox under a commercial licence to anyone who cannot accept the AGPLv3 — a reseller who wants to
distribute it without publishing their modifications, for instance. That option is what makes
building this sustainable, and it is also the enforcement lever against a rebrand-and-sell: the
AGPLv3 route requires publishing source, and the other route has to be bought.

The moment a contribution arrives whose author has not granted that right, the option is gone for
the whole project — not just for that file — because Velnox could no longer be relicensed as a
whole. It cannot be recovered later without tracking down every contributor.

**What it does not allow.** This agreement does not let The Foundation make Velnox proprietary and
take it away from you. Every version already released under the AGPLv3 stays under the AGPLv3
permanently; that grant is irrevocable and runs to everyone who received it. If The Foundation ever
stopped publishing Velnox as free software, the last AGPL release could be forked and continued by
anyone, including you, with your contribution in it.

---

## Signing

Add your name to `CONTRIBUTORS.md` in the same pull request as your first contribution, with the
line:

```
Name <email> — agreed to CLA.md on YYYY-MM-DD
```

Sign your commits off as well, which records the same intent in the history:

```bash
git commit --signoff
```

If you would rather not sign, contribute anyway — open an issue describing the change instead of a
pull request. An idea, a reproduction case or a well-argued bug report is worth having and needs no
agreement at all.

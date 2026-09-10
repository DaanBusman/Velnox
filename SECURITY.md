# Security policy

## Reporting a vulnerability

**Report privately, and give us time to fix it before it is public.**

Two channels, both fine:

- **GitHub** — open a private security advisory on this repository
  (*Security → Advisories → Report a vulnerability*). This is preferred: it keeps the report, the
  fix and the eventual disclosure in one place.
- **Email** — `daanbusman@gmail.com`. Put "Velnox security" in the subject.

Please do **not** open a public issue, post it to a forum, or demonstrate it against an installation
you do not own.

### What to include

Whatever you have. A report with less than this is still worth sending.

- What the issue is, and what an attacker gets from it.
- How to reproduce it — steps, a request, a script, a screenshot.
- The version, from **Settings → About** or `GET /api/v1/system/source`.
- Whether you have told anyone else.

### What happens next

| When | What |
|---|---|
| Within 3 working days | We acknowledge the report and say whether we can reproduce it |
| Within 10 working days | An assessment: severity, whether it is in scope, and a target date |
| Before disclosure | We agree the timing with you, and we tell you when the fix ships |

Ninety days is the default disclosure window, sooner where a fix is quick and the risk is high. If
we go quiet, or you disagree with our assessment, you are free to disclose after ninety days — that
is a commitment, not a threat we are inviting.

We will credit you by name in the advisory unless you would rather we did not. There is no bug
bounty; this is a self-funded project and we would rather be honest about that than imply one.

---

## Safe harbour

If you make a good-faith effort to follow this policy, we will not pursue or support legal action
against you for your research. Specifically, we consider the following authorised:

- Testing against **your own installation** of Velnox.
- Testing against a copy you have deployed yourself for the purpose.

We cannot authorise, and this safe harbour does not cover:

- Testing against an installation belonging to someone else, including an MSP's or their customers'.
- Accessing, modifying or deleting data that is not yours.
- Denial of service, spam, or social engineering of anyone.

If you are unsure whether something is in scope, ask first at the address above.

---

## Scope

**In scope:** this repository — the API, the worker, the web application, the shared packages, the
deployment configuration, the installer and the scripts.

**Out of scope, but still tell us:**

- Vulnerabilities in dependencies. Report those upstream first; tell us so we can pin or patch.
- Findings in Proxmox VE, VMware, Hyper-V or Microsoft Entra ID. Those belong to their vendors.
- An operator's own misconfiguration — though if Velnox makes that misconfiguration easy or hard to
  notice, that **is** in scope and we want to hear it.

---

## What we already publish about our own weaknesses

[docs/known-gaps.md](docs/known-gaps.md) lists what is deliberately not built and what is not built
*yet*, including security-relevant gaps — the DNS-rebinding window in the OIDC discovery guard, the
`'unsafe-inline'` still in the Content-Security-Policy, the absence of a session list. Reporting one
of those is not a waste of your time; a report that one is worse than we assessed is exactly the
kind we want.

---

## Supported versions

Velnox is pre-1.0 and built in phases. Only the latest release is supported: fixes go to `main` and
ship in the next version. There are no backports to earlier versions, and there will not be until
1.0.

Check what you are running with **Settings → About**, or:

```bash
cd /opt/velnox && sudo bash scripts/tls.sh --status
```

---

*This policy is also what the EU Cyber Resilience Act (Regulation 2024/2847, Article 13 and
Annex I Part II) requires of a manufacturer: a coordinated vulnerability disclosure policy with a
single point of contact. Velnox is not yet in scope of the CRA's obligations, and publishing this
now is cheaper than retrofitting it later.*

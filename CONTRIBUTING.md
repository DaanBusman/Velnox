# Contributing to Velnox

Velnox is built in phases against a published roadmap, currently by one person. Contributions are
welcome; a note before you start a large one is welcome too, because the roadmap is opinionated
about order and something built out of turn may sit unmerged for a phase or two.

**Found a security problem? Do not open an issue.** [SECURITY.md](SECURITY.md) has the private
channels and what happens next.

---

## Before a pull request

You need to agree to the [Contributor Licence Agreement](CLA.md). You keep the copyright in what you
write; the agreement grants The Velnox Foundation a licence to it, including the right to distribute
it under commercial terms alongside the AGPLv3. Section 8 of that document explains why that is
asked and — just as importantly — what it does not allow.

If you would rather not sign, open an issue instead of a pull request. A reproduction case or a
well-argued bug report needs no agreement at all and is worth having.

---

## Getting set up

```bash
pnpm install && pnpm build
```

The package manager is pinned in `packageManager` and pnpm 12 is a native binary; if your global
pnpm is older, see the note in [README.md](README.md#development).

| Command | What it does |
|---|---|
| `pnpm lint` | ESLint, plus glossary, locale, version and command validation |
| `pnpm typecheck` | TypeScript across every package |
| `pnpm test` | Unit tests |
| `pnpm run validate:all` | Everything the CI gates on except the build |

---

## What a change is expected to carry

These are not style preferences. Each one exists because its absence caused a real problem, and most
of them are enforced by a script that will fail your build rather than by a reviewer's memory.

**A version bump.** `pnpm run version:bump patch`, in the same change. Below 1.0.0 the minor number
is the phase number and only a completed phase moves it — see [ADR-024](docs/tech-decisions.md).
`pnpm run validate:version` fails on drift.

**Both languages.** Every user-visible string lives in `packages/i18n/locales/en.json` **and**
`nl.json`, in the same commit. No sentence is written in application source, and the API returns
error *codes* rather than prose so the frontend renders them in the reader's language
([ADR-019](docs/tech-decisions.md)). `pnpm run validate:i18n` fails on a missing key or a mismatched
ICU argument.

**Documentation, in the same change as the feature.** Task-shaped guides for anything an operator
does; the reference documents for anything about how the system is built
([ADR-026](docs/tech-decisions.md)). Dutch translations record the English commit they came from —
`node scripts/check-doc-sync.mjs` reports which have fallen behind.

**A test that would fail without your fix.** Not a test that passes; a test you have watched fail
for the reason you are fixing, then watched pass. Several of the specs in this repository exist
because a "fix" was verified only by reading it.

**Audit events for anything that mutates**, and a permission check for anything that reads or writes
something that is not the caller's own.

**Honesty about what you did not do.** If something is unfinished, say so in
[docs/known-gaps.md](docs/known-gaps.md) rather than leaving it to be discovered. A shipped gap that
is written down is a decision; the same gap undocumented is a defect.

---

## What will be sent back

- A dependency added without a reason that could not be met by the existing ones. Every dependency
  is carried into every future licence review, and `pnpm run validate:licenses` gates on AGPLv3
  compatibility.
- Secrets, credentials or tokens reachable from a log, an API response, an audit record or the
  frontend. `packages/shared/src/redaction.ts` and its spec are the line.
- `rejectUnauthorized: false` on any outbound connection. There is one exception in the codebase, it
  is argued in a block comment, and it needed measuring to justify.
- Shell commands run from an HTTP endpoint.
- A tenant id taken from the request rather than from the authenticated principal.
- Comments that restate the code. Comments here explain *why*, and are expected to survive being
  read by someone who was not there.

---

## Commit messages

Say what changed and why it needed to. The body is where the reasoning goes, and it is worth more
than the subject line — several commits in this history are the only record of why a design is the
way it is.

Sign your commits off:

```bash
git commit --signoff
```

---

## Where things are

| Path | What lives there |
|---|---|
| `apps/api` | NestJS API — auth, RBAC, audit, system endpoints |
| `apps/worker` | The only service that reaches managed infrastructure |
| `apps/web` | Next.js frontend |
| `packages/shared` | The permission catalogue, error codes, redaction — the contracts |
| `packages/db` | Prisma schema and migrations |
| `docs/` | Operator guides and reference documents, bundled into the product at build time |
| `scripts/` | Installer, verification, and the validators CI runs |

[docs/architecture.md](docs/architecture.md) explains how it fits together;
[docs/tech-decisions.md](docs/tech-decisions.md) explains why, with what each choice cost.

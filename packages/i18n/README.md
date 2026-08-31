# @velnox/i18n

Localization for Velnox. English (`en`) is the source language; Dutch (`nl`) ships alongside it.
Adding a third language must never require touching application code.

---

## What lives here

```
packages/i18n/
├─ glossary.csv          # domain terminology, one row per term  ← the source of truth
├─ locales/
│  ├─ en.json            # UI message catalogue (source language)
│  └─ nl.json            # UI message catalogue (translation)
├─ src/                  # (from Phase 1) loader, type generation, formatters
└─ README.md
```

## glossary.csv

The controlled vocabulary. Every domain term Velnox uses in its UI, its documentation and its API
error messages appears here exactly once, with an agreed translation per language.

| Column | Meaning |
|---|---|
| `term_key` | Stable identifier, `namespace.term`. Never renamed once released. |
| `en` | English term. The source of truth for meaning. |
| `nl` | Dutch term. |
| `definition` | What the term means in Velnox specifically. Written for a translator who does not know the product. |
| `translate` | `no` = product, vendor or protocol name that **must stay byte-identical in every language**. `yes` = translate it. |

Format is RFC 4180 CSV, UTF-8, every field quoted, no comment rows — so it opens cleanly in a
spreadsheet and diffs cleanly in git. Namespaces currently in use: `product`, `vendor`, `tech`,
`org`, `infra`, `health`, `auth`, `sec`, `job`, `auto`, `upd`, `upg`, `ceph`, `mig`, `ui`.

### Adding a language

1. Add a column with the ISO 639-1 code (e.g. `de`) to `glossary.csv` and fill every row where
   `translate` is `yes`. Rows with `translate=no` get the English value copied verbatim.
2. Copy `locales/en.json` to `locales/de.json` and translate the values, using the glossary for
   every domain term so wording stays consistent across screens.
3. Register the locale in the config. No component, route or API change is required.

### Rules

- A term whose `translate` value is `no` is **never** translated, not even partially. `HEALTH_OK`
  stays `HEALTH_OK`; `Tenant` stays `Tenant`.
- If a translation would need a different word in two different screens, that is two terms with two
  keys — not one term used loosely.
- Changing the meaning of a term means adding a new `term_key` and deprecating the old one, because
  translations of the old key already exist in other languages.
- CI validates the file: parses as CSV, no duplicate keys, no empty cells, `translate` ∈
  {`yes`,`no`}, every language column complete.

## locales/*.json

Flat-namespaced ICU MessageFormat catalogues consumed by the frontend. Interpolation and
pluralisation are ICU, so languages with different plural rules need no code change.

## Error messages are keys, not sentences

The API never returns a human-readable sentence as its primary error. It returns a machine-readable
code plus typed parameters:

```json
{ "error": { "code": "cluster.quorum_at_risk",
             "params": { "cluster": "prod-a", "available": 2, "required": 3 } } }
```

The frontend renders `errors.cluster.quorum_at_risk` from the active locale. This keeps every
user-visible string in the catalogue instead of scattered across backend source, and means a new
language covers API errors automatically.

Log lines, audit records and job events stay **English-only and untranslated** — they are forensic
records, and a support engineer reading a customer's audit trail must not have to guess which
language it was written in.

## Documentation

English under `docs/`, Dutch under `docs/nl/`. English is canonical: where the two disagree, the
English text governs. See [../../docs/i18n.md](../../docs/i18n.md).

---

*Velnox™ is a trademark of The Velnox Foundation.*

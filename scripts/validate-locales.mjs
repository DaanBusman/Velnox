#!/usr/bin/env node
/**
 * Validates packages/i18n/locales/*.json.
 *
 * Rules, per docs/i18n.md:
 *   - every key in the source locale exists in every other locale
 *   - no locale carries keys the source does not have
 *   - the ICU argument set of each message matches across locales
 *   - no empty message values
 *
 * A missing translation is a build failure, not a silent English fallback in the
 * middle of a Dutch screen. That is the whole point of the check.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, basename } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = resolve(here, '..', 'packages', 'i18n', 'locales');
const SOURCE = 'en';

/**
 * Collect leaf keys as dotted paths, skipping $-prefixed metadata.
 * @param {any} obj
 * @param {string} prefix
 * @param {Map<string,string>} out
 */
function flatten(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('$')) continue;
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      flatten(v, path, out);
    } else if (typeof v === 'string') {
      out.set(path, v);
    } else {
      out.set(path, String(v));
    }
  }
  return out;
}

/**
 * Extract ICU argument names. Matches `{name}` and `{name, plural, ...}` but not
 * `{# selected}` or the literal sub-message braces inside a plural.
 * @param {string} message
 */
function icuArgs(message) {
  const args = new Set();
  const re = /\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*[,}]/g;
  let m;
  while ((m = re.exec(message)) !== null) args.add(m[1]);
  return args;
}

const files = readdirSync(localesDir).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
const locales = new Map();

for (const f of files) {
  const name = basename(f, '.json');
  try {
    locales.set(name, flatten(JSON.parse(readFileSync(join(localesDir, f), 'utf8')), '', new Map()));
  } catch (err) {
    console.error(`${f}: not valid JSON — ${err.message}`);
    process.exit(1);
  }
}

if (!locales.has(SOURCE)) {
  console.error(`Source locale "${SOURCE}.json" not found in ${localesDir}.`);
  process.exit(1);
}

const source = locales.get(SOURCE);
/** @type {string[]} */
const errors = [];

for (const [key, value] of source) {
  if (!value.trim()) errors.push(`${SOURCE}: "${key}" is empty.`);
}

for (const [locale, messages] of locales) {
  if (locale === SOURCE) continue;

  for (const key of source.keys()) {
    if (!messages.has(key)) errors.push(`${locale}: missing key "${key}".`);
  }
  for (const key of messages.keys()) {
    if (!source.has(key)) errors.push(`${locale}: has key "${key}" which ${SOURCE} does not.`);
  }
  for (const [key, value] of messages) {
    if (!source.has(key)) continue;
    if (!value.trim()) {
      errors.push(`${locale}: "${key}" is empty.`);
      continue;
    }
    const want = icuArgs(source.get(key));
    const got = icuArgs(value);
    const missing = [...want].filter((a) => !got.has(a));
    const extra = [...got].filter((a) => !want.has(a));
    if (missing.length || extra.length) {
      errors.push(
        `${locale}: "${key}" ICU arguments differ — ` +
          `${missing.length ? `missing {${missing.join('}, {')}}` : ''}` +
          `${missing.length && extra.length ? '; ' : ''}` +
          `${extra.length ? `unexpected {${extra.join('}, {')}}` : ''}.`,
      );
    }
  }
}

if (errors.length) {
  console.error(`locales FAILED with ${errors.length} error(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.warn(
  `locales OK — ${locales.size} locales [${[...locales.keys()].join(', ')}], ` +
    `${source.size} keys each, ICU arguments consistent.`,
);

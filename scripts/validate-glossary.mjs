#!/usr/bin/env node
/**
 * Validates packages/i18n/glossary.csv.
 *
 * The glossary is the controlled vocabulary described in docs/i18n.md. It is the
 * source of truth for UI catalogues and for the Dutch documentation, so a
 * malformed or inconsistent row propagates into both. This check is CI-blocking.
 *
 * Adding a language means adding a column; this script then requires that column
 * to be complete, which is what makes "adding a language is a data change" true
 * rather than aspirational.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseCsvObjects } from './lib/csv.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const file = resolve(here, '..', 'packages', 'i18n', 'glossary.csv');

const FIXED_COLUMNS = ['term_key', 'definition', 'translate'];
const SOURCE_LANGUAGE = 'en';
const KEY_PATTERN = /^[a-z][a-z0-9]*\.[a-z][a-z0-9_]*$/;

/** @type {string[]} */
const errors = [];
/** @type {string[]} */
const warnings = [];

let parsed;
try {
  parsed = parseCsvObjects(readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`glossary.csv: ${err.message}`);
  process.exit(1);
}

const { header, rows, lineOf } = parsed;

for (const col of FIXED_COLUMNS) {
  if (!header.includes(col)) errors.push(`Missing required column "${col}".`);
}
if (!header.includes(SOURCE_LANGUAGE)) {
  errors.push(`Missing source language column "${SOURCE_LANGUAGE}".`);
}

const languages = header.filter((h) => h && !FIXED_COLUMNS.includes(h));
if (languages.length < 1) errors.push('No language columns found.');

if (errors.length) {
  console.error('glossary.csv is structurally invalid:');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

const seen = new Map();

rows.forEach((row, i) => {
  const line = lineOf(i);
  const key = row.term_key;
  const where = `line ${line} (${key || '<no key>'})`;

  if (Number(row.__cellCount) !== header.length) {
    errors.push(`${where}: has ${row.__cellCount} cells, expected ${header.length}.`);
  }

  if (!key) {
    errors.push(`${where}: term_key is empty.`);
    return;
  }
  if (!KEY_PATTERN.test(key)) {
    errors.push(`${where}: term_key must be "namespace.term" in lower snake case.`);
  }
  if (seen.has(key)) {
    errors.push(`${where}: duplicate term_key, first seen on line ${seen.get(key)}.`);
  } else {
    seen.set(key, line);
  }

  if (!row.definition || !row.definition.trim()) {
    errors.push(`${where}: definition is empty. A translator needs it to do their job.`);
  }

  if (row.translate !== 'yes' && row.translate !== 'no') {
    errors.push(`${where}: translate must be "yes" or "no", got "${row.translate}".`);
    return;
  }

  for (const lang of languages) {
    if (!row[lang] || !row[lang].trim()) {
      errors.push(`${where}: language column "${lang}" is empty.`);
    }
  }

  // A term flagged as untranslatable is a product, vendor or protocol name. If a
  // language column differs from the source, either the flag is wrong or someone
  // translated a name they should not have.
  if (row.translate === 'no') {
    for (const lang of languages) {
      if (lang !== SOURCE_LANGUAGE && row[lang] !== row[SOURCE_LANGUAGE]) {
        errors.push(
          `${where}: translate="no" but "${lang}" (${row[lang]}) differs from ` +
            `"${SOURCE_LANGUAGE}" (${row[SOURCE_LANGUAGE]}). ` +
            `Either it is translatable (set translate="yes") or the translation is wrong.`,
        );
      }
    }
  }

  for (const lang of languages) {
    const v = row[lang];
    if (v && v !== v.trim()) warnings.push(`${where}: "${lang}" has leading/trailing whitespace.`);
  }
});

const namespaces = [...new Set([...seen.keys()].map((k) => k.split('.')[0]))].sort();

if (warnings.length) {
  console.warn('glossary.csv warnings:');
  for (const w of warnings) console.warn(`  - ${w}`);
}

if (errors.length) {
  console.error(`\nglossary.csv FAILED with ${errors.length} error(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.warn(
  `glossary.csv OK — ${rows.length} terms, languages [${languages.join(', ')}], ` +
    `${rows.filter((r) => r.translate === 'no').length} untranslatable, ` +
    `${namespaces.length} namespaces.`,
);

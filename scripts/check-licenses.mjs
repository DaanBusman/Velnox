#!/usr/bin/env node
/**
 * Dependency licence gate.
 *
 * Velnox is AGPL-3.0-or-later. Discovering an incompatible dependency late means
 * rewriting whatever was built on it, so this runs from Phase 1 on every install
 * rather than as an audit at the end (docs/risks.md R-24).
 *
 * Usage:
 *   node scripts/check-licenses.mjs            fail on anything not allowed
 *   node scripts/check-licenses.mjs --report   print the inventory, never fail
 */
import { execFileSync } from 'node:child_process';

const REPORT_ONLY = process.argv.includes('--report');

/**
 * Licences that may be combined into an AGPL-3.0-or-later work.
 * Permissive licences impose no restriction on the combined work; GPL-3.0 and
 * LGPL-3.0 are explicitly compatible with AGPL-3.0.
 */
const ALLOWED = new Set([
  '0BSD',
  'AGPL-3.0',
  'AGPL-3.0-only',
  'AGPL-3.0-or-later',
  'Apache-2.0',
  'Artistic-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'CC0-1.0',
  'GPL-3.0',
  'GPL-3.0-only',
  'GPL-3.0-or-later',
  'ISC',
  'LGPL-3.0',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
  'MIT',
  'MIT-0',
  'MPL-2.0',
  'Python-2.0',
  'Unlicense',
  'WTFPL',
  'Zlib',
]);

/**
 * Licences that are actively incompatible or non-free, reported separately from
 * "unrecognised" because the answer differs: these can never be resolved by
 * adding them to the allowlist.
 */
const FORBIDDEN = new Set([
  'BUSL-1.1',
  'CC-BY-NC-4.0',
  'CC-BY-NC-SA-4.0',
  'Elastic-2.0',
  'GPL-2.0',
  'GPL-2.0-only',
  'SSPL-1.0',
  'UNLICENSED',
]);

/**
 * Evaluate an SPDX expression. `A OR B` passes if either side passes;
 * `A AND B` requires both. Parentheses are stripped — the expressions that occur
 * in practice are flat.
 * @param {string} expr
 * @returns {{ ok: boolean, forbidden: boolean }}
 */
function evaluate(expr) {
  const clean = String(expr || '')
    .replace(/[()]/g, ' ')
    .trim();
  if (!clean) return { ok: false, forbidden: false };

  // Whitespace-delimited, not \b-delimited: a word boundary also matches the
  // "or" inside "LGPL-3.0-or-later", which shredded a valid expression into
  // "LGPL-3.0-" and "-later" and reported it as unrecognised.
  if (/\sOR\s/i.test(clean)) {
    const parts = clean.split(/\sOR\s/i).map((p) => p.trim());
    const results = parts.map(evaluate);
    return { ok: results.some((r) => r.ok), forbidden: results.every((r) => r.forbidden) };
  }
  if (/\sAND\s/i.test(clean)) {
    const parts = clean.split(/\sAND\s/i).map((p) => p.trim());
    const results = parts.map(evaluate);
    return { ok: results.every((r) => r.ok), forbidden: results.some((r) => r.forbidden) };
  }

  const id = clean.replace(/\+$/, '-or-later');
  return { ok: ALLOWED.has(id) || ALLOWED.has(clean), forbidden: FORBIDDEN.has(id) };
}

let raw;
try {
  raw = execFileSync('pnpm', ['licenses', 'list', '--json', '--recursive'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
} catch (err) {
  const out = err.stdout?.toString() ?? '';
  if (!out.trim().startsWith('{') && !out.trim().startsWith('[')) {
    console.error('Could not run "pnpm licenses list --json". Have you run "pnpm install"?');
    console.error(err.stderr?.toString() ?? err.message);
    process.exit(REPORT_ONLY ? 0 : 1);
  }
  raw = out;
}

let data;
try {
  data = JSON.parse(raw);
} catch {
  console.error('Could not parse the output of "pnpm licenses list --json".');
  process.exit(REPORT_ONLY ? 0 : 1);
}

/** @type {{name:string, version:string, license:string}[]} */
const packages = [];
if (Array.isArray(data)) {
  for (const p of data) {
    packages.push({ name: p.name, version: p.version ?? '', license: p.license ?? 'UNKNOWN' });
  }
} else {
  for (const [license, entries] of Object.entries(data)) {
    for (const p of entries) {
      packages.push({
        name: p.name,
        version: Array.isArray(p.versions) ? p.versions.join(', ') : (p.version ?? ''),
        license,
      });
    }
  }
}

const forbidden = [];
const unrecognised = [];
const counts = new Map();

for (const p of packages) {
  counts.set(p.license, (counts.get(p.license) ?? 0) + 1);
  const { ok, forbidden: isForbidden } = evaluate(p.license);
  if (isForbidden) forbidden.push(p);
  else if (!ok) unrecognised.push(p);
}

const summary = [...counts.entries()].sort((a, b) => b[1] - a[1]);

if (REPORT_ONLY) {
  console.warn(`Licence inventory (${packages.length} packages):`);
  for (const [lic, n] of summary) console.warn(`  ${String(n).padStart(5)}  ${lic}`);
  process.exit(0);
}

if (forbidden.length) {
  console.error(`FORBIDDEN licences found (${forbidden.length}) — these cannot be used in Velnox:`);
  for (const p of forbidden) console.error(`  - ${p.name}@${p.version}: ${p.license}`);
}

if (unrecognised.length) {
  console.error(`\nUnrecognised licences (${unrecognised.length}) — review each one:`);
  for (const p of unrecognised) console.error(`  - ${p.name}@${p.version}: ${p.license}`);
  console.error(
    '\nIf a licence is AGPL-3.0-compatible, add its SPDX identifier to ALLOWED in ' +
      'scripts/check-licenses.mjs, in a commit that says why.',
  );
}

if (forbidden.length || unrecognised.length) process.exit(1);

console.warn(`Licences OK — ${packages.length} packages, all AGPL-3.0-or-later compatible.`);
for (const [lic, n] of summary) console.warn(`  ${String(n).padStart(5)}  ${lic}`);

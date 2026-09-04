#!/usr/bin/env node
/**
 * The version number, in one place.
 *
 * Velnox writes its version into ten package manifests, two compose defaults and
 * the documentation bundle that ships inside the product. Keeping those in step
 * by hand works right up until it does not, and the failure is silent: an
 * installation that reports one version while its documentation describes
 * another is worse than one with no documentation at all.
 *
 * So the root package.json is the single source, and this script is the only
 * thing that writes a version anywhere.
 *
 *   node scripts/version.mjs                 print the current version
 *   node scripts/version.mjs check           fail if anything has drifted
 *   node scripts/version.mjs set 0.3.0       write it everywhere
 *   node scripts/version.mjs bump minor      0.2.0 -> 0.3.0
 *   node scripts/version.mjs bump patch      0.2.0 -> 0.2.1
 *
 * `bump major` is refused below 1.0.0 on purpose: reaching 1.0.0 is a product
 * decision the owner makes, not something a script does because the number was
 * next.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every manifest that carries the version. */
const MANIFESTS = [
  'package.json',
  'apps/api/package.json',
  'apps/web/package.json',
  'apps/worker/package.json',
  'packages/config/package.json',
  'packages/crypto/package.json',
  'packages/db/package.json',
  'packages/i18n/package.json',
  'packages/shared/package.json',
];

/**
 * The compose file carries the version as a fallback for anyone running
 * `docker compose` without the `.env` the installer writes. A stale fallback
 * there means the product under-reports its own version.
 */
const COMPOSE = 'deploy/compose/docker-compose.yml';
const COMPOSE_PATTERN = /(VELNOX_VERSION: \$\{VELNOX_VERSION:-)([^}]+)(\})/g;

/**
 * The example environment. The installer overwrites `VELNOX_VERSION` in a real
 * `.env` on every run, but someone reading this file to understand the settings
 * should not be shown a version that stopped being true three releases ago.
 */
const ENV_EXAMPLE = '.env.example';
const ENV_PATTERN = /^(VELNOX_VERSION=)(.+)$/gm;

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;

const read = (file) => readFileSync(join(ROOT, file), 'utf8');
const write = (file, content) => writeFileSync(join(ROOT, file), content);

export function currentVersion() {
  return JSON.parse(read('package.json')).version;
}

/** Every place a version is written, with what it currently says. */
function findAll() {
  const found = [];

  for (const file of MANIFESTS) {
    found.push({ file, version: JSON.parse(read(file)).version });
  }

  for (const match of read(COMPOSE).matchAll(COMPOSE_PATTERN)) {
    found.push({ file: COMPOSE, version: match[2] });
  }

  for (const match of read(ENV_EXAMPLE).matchAll(ENV_PATTERN)) {
    found.push({ file: ENV_EXAMPLE, version: match[2] });
  }

  return found;
}

function check() {
  const expected = currentVersion();
  const drifted = findAll().filter((entry) => entry.version !== expected);

  if (drifted.length > 0) {
    console.error(`Version drift: package.json says ${expected}, but:`);
    for (const entry of drifted) console.error(`  ${entry.file} says ${entry.version}`);
    console.error('\nRun: node scripts/version.mjs set ' + expected);
    process.exit(1);
  }

  console.log(`Version OK — ${expected} in ${findAll().length} places.`);
}

function set(version) {
  if (!SEMVER.test(version)) {
    console.error(`Not a version: ${version}`);
    process.exit(1);
  }

  for (const file of MANIFESTS) {
    const manifest = JSON.parse(read(file));
    manifest.version = version;
    // Trailing newline, because every other manifest in the repo has one and a
    // diff that is only a missing newline wastes a reviewer's attention.
    write(file, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  write(COMPOSE, read(COMPOSE).replace(COMPOSE_PATTERN, `$1${version}$3`));
  write(ENV_EXAMPLE, read(ENV_EXAMPLE).replace(ENV_PATTERN, `$1${version}`));

  console.log(`Set ${version} in ${findAll().length} places.`);
  console.log(`Next: rebuild so the documentation bundle carries it too.`);
}

function bump(part) {
  const current = currentVersion();
  const match = SEMVER.exec(current);
  if (!match) {
    console.error(`Current version is not usable: ${current}`);
    process.exit(1);
  }

  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];

  if (part === 'major') {
    // Deliberate refusal. 1.0.0 says "this is finished enough to depend on",
    // which is a claim about the product, not an arithmetic step.
    console.error(
      'Refusing to bump the major version automatically.\n' +
        'Reaching 1.0.0 is a decision the product owner makes; run `set 1.0.0` when they say so.',
    );
    process.exit(1);
  }

  const next =
    part === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;

  set(next);
}

const [command, argument] = process.argv.slice(2);

switch (command) {
  case undefined:
    console.log(currentVersion());
    break;
  case 'check':
    check();
    break;
  case 'set':
    if (!argument) {
      console.error('Usage: node scripts/version.mjs set <version>');
      process.exit(1);
    }
    set(argument);
    break;
  case 'bump':
    if (!['major', 'minor', 'patch'].includes(argument ?? '')) {
      console.error('Usage: node scripts/version.mjs bump <major|minor|patch>');
      process.exit(1);
    }
    bump(argument);
    break;
  default:
    console.error(`Unknown command: ${command}`);
    console.error(`Try: check | set <version> | bump <minor|patch>`);
    process.exit(1);
}

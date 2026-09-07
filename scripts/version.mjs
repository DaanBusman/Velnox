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
 *   node scripts/version.mjs bump patch      0.2.0 -> 0.2.1
 *   node scripts/version.mjs phase 3         0.2.7 -> 0.3.0
 *
 * ## Below 1.0.0, the minor number is the phase number
 *
 * Velnox is built in fifteen phases and 1.0.0 is the first real release, so the
 * two have to meet. Spending a minor on every feature does not get there: at one
 * minor per change this reached 0.8.0 during Phase 2, and Phase 15 would have
 * landed past 0.20.0 — a number saying nothing about how far along the product
 * is, and nowhere near the release it is supposed to arrive at.
 *
 * So the minor *is* the phase. A build reporting 0.4.6 is the sixth shipped
 * change since Phase 4 was completed. Every change bumps the patch; completing a
 * phase runs `phase <n>`, which is the only thing that moves the minor and which
 * refuses unless docs/roadmap.md marks that phase complete. Phase 15 therefore
 * ends at 0.15.x, and 1.0.0 is one deliberate step from there.
 *
 * `bump minor` is refused because it would silently spend a phase number.
 * `bump major` is refused because reaching 1.0.0 is a product decision the owner
 * makes, not something a script does because the number was next.
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

/** Where "how far along is this" is recorded. The version follows it, never leads. */
const ROADMAP = 'docs/roadmap.md';

/** Phases 1 to 15, and then 1.0.0. */
const MAX_PHASE = 15;

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

/**
 * The highest phase docs/roadmap.md marks complete.
 *
 * Parsed from the roadmap rather than recorded separately, because a second
 * record of "how far along are we" is a second thing to forget to update. The
 * headings look like:
 *
 *     ## Phase 2 — Authentication, setup wizard, RBAC core · **XL** · ✅ complete
 *
 * Phase 9 is split into 9A and 9B. Both are phase 9, so both live under minor 9
 * and 9B ships as patches on it.
 */
export function completedPhase() {
  let highest = 0;

  for (const line of read(ROADMAP).split('\n')) {
    const match = /^##\s+Phase\s+(\d+)[AB]?\b/.exec(line);
    if (!match) continue;
    if (!/✅\s*complete/i.test(line)) continue;
    highest = Math.max(highest, Number(match[1]));
  }

  return highest;
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

  /*
   * The minor number has to be the phase the roadmap says is finished.
   *
   * Not checked from 1.0.0 on: after the first real release the number stops
   * tracking phases and starts meaning what semver says it means.
   */
  const parts = SEMVER.exec(expected);
  const major = Number(parts?.[1]);
  const minor = Number(parts?.[2]);

  if (major === 0) {
    const phase = completedPhase();
    if (minor !== phase) {
      console.error(
        `Version ${expected} does not match the roadmap. Phase ${phase} is the highest one ` +
          `marked complete, so the minor number should be ${phase}.`,
      );
      console.error(`\nJust finished a phase?   node scripts/version.mjs phase ${phase}`);
      console.error(
        'Otherwise the roadmap and the version disagree about how far along this is,\n' +
          'which is worth resolving before shipping either.',
      );
      process.exit(1);
    }
    console.log(
      `Version OK — ${expected} in ${findAll().length} places, minor matches completed Phase ${phase}.`,
    );
    return;
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

/**
 * Completing a phase: the one thing that moves the minor number.
 *
 * Refuses to run ahead of the roadmap. The version is a claim about how far
 * along the product is, and the roadmap is where that claim is actually made —
 * so marking the phase complete there is part of finishing it, not paperwork
 * afterwards.
 */
function phase(requested) {
  const number = Number(requested);
  if (!Number.isInteger(number) || number < 1 || number > MAX_PHASE) {
    console.error(`Not a phase: ${requested}. Velnox has phases 1 to ${MAX_PHASE}.`);
    process.exit(1);
  }

  const current = currentVersion();
  const parts = SEMVER.exec(current);
  const major = Number(parts?.[1]);
  const minor = Number(parts?.[2]);

  if (major !== 0) {
    console.error(`Already at ${current}. Phase numbering applies below 1.0.0 only.`);
    process.exit(1);
  }

  if (number < minor) {
    console.error(`Refusing to go backwards: ${current} is already Phase ${minor}.`);
    process.exit(1);
  }

  const marked = completedPhase();
  if (number > marked) {
    console.error(
      `docs/roadmap.md does not mark Phase ${number} complete — the highest it marks is ` +
        `${marked || 'none'}.`,
    );
    console.error(
      '\nMark it complete there first, in the change that finishes it.\n' +
        'The version follows the roadmap; it does not lead it.',
    );
    process.exit(1);
  }

  set(`0.${number}.0`);
  console.log(
    number === MAX_PHASE
      ? 'Phase 15 complete. 1.0.0 is now one deliberate step away — run `set 1.0.0` when the owner says so.'
      : `Phase ${number} complete. Changes from here bump the patch until Phase ${number + 1} lands.`,
  );
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

  if (part === 'minor' && major === 0) {
    // Below 1.0.0 the minor is the phase number. Bumping it for a feature is how
    // this reached 0.8.0 during Phase 2 — spending most of the numbering before
    // a fifth of the work was done.
    console.error(
      'Refusing to bump the minor version: below 1.0.0 it is the phase number, not a\n' +
        'feature counter.\n',
    );
    console.error('  A shipped change:   node scripts/version.mjs bump patch');
    console.error('  A completed phase:  node scripts/version.mjs phase <n>');
    process.exit(1);
  }

  const next = part === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;

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
      console.error('Usage: node scripts/version.mjs bump patch');
      process.exit(1);
    }
    bump(argument);
    break;
  case 'phase':
    if (!argument) {
      console.error(`Usage: node scripts/version.mjs phase <1-${MAX_PHASE}>`);
      process.exit(1);
    }
    phase(argument);
    break;
  default:
    console.error(`Unknown command: ${command}`);
    console.error('Try: check | set <version> | bump patch | phase <n>');
    process.exit(1);
}

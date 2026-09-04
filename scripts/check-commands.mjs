#!/usr/bin/env node
/**
 * Documented commands have to work when pasted.
 *
 * Two ways they stop working, both silent:
 *
 *   1. A command that runs a script by path — `sudo /opt/velnox/install.sh` or
 *      `./scripts/verify-stack.sh` — needs the file's executable bit. That bit
 *      does not survive a zip download from GitHub, a clone onto a Windows or
 *      CIFS filesystem, or a copy through anything that drops permissions. The
 *      result is "Permission denied" on the very first command a new user
 *      pastes, which is a terrible first impression and an avoidable one.
 *
 *      So every documented invocation goes through `bash`, the way install.sh
 *      already calls gen-env.sh and verify-stack.sh internally.
 *
 *   2. The executable bit going missing in the repository itself, which breaks
 *      `./install.sh` for anyone who prefers to run it that way.
 *
 * This asserts both. It runs in `pnpm run lint`.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Files whose commands a reader is expected to copy and run. */
const DOCUMENTS = [
  'README.md',
  'docs/README.md',
  'docs/deployment.md',
  'docs/roadmap.md',
  'docs/nl/README.md',
  'docs/nl/deployment.md',
  'docs/nl/roadmap.md',
];

/** Entry-point scripts. Sourced libraries are deliberately absent. */
const ENTRY_POINTS = [
  'install.sh',
  'scripts/gen-env.sh',
  'scripts/verify-stack.sh',
  'scripts/test-install-ui.sh',
];

/**
 * A shell script invoked by path with no interpreter in front of it.
 *
 * Matches `./install.sh`, `sudo /opt/velnox/install.sh`, `sudo ./install.sh`,
 * `bash` and `sh` prefixes excluded by the lookbehind on the interpreter.
 */
const DIRECT_INVOCATION = /(?<![\w/.-])(?:sudo\s+(?:-\S+\s+)*)?(?:\.\/|\/)\S*\.sh\b/g;
const INTERPRETED = /\b(?:bash|sh|source)\s+\S*\.sh\b/;

const problems = [];

for (const file of DOCUMENTS) {
  let content;
  try {
    content = readFileSync(join(ROOT, file), 'utf8');
  } catch {
    continue; // Not every document exists in every branch.
  }

  content.split('\n').forEach((line, index) => {
    // A line that already names an interpreter is fine, however it also matches.
    if (INTERPRETED.test(line)) return;

    for (const match of line.matchAll(DIRECT_INVOCATION)) {
      problems.push(
        `${file}:${index + 1}  ${match[0].trim()}\n` +
          '    Runs a script by path, which needs its executable bit. Put `bash` in front.',
      );
    }
  });
}

// The executable bit as git records it, which is what a clone actually gets.
try {
  const listing = execFileSync('git', ['ls-files', '-s', '--', ...ENTRY_POINTS], {
    cwd: ROOT,
    encoding: 'utf8',
  });

  for (const line of listing.trim().split('\n').filter(Boolean)) {
    const [mode, , , path] = line.split(/\s+/);
    if (mode !== '100755') {
      problems.push(
        `${path}  is mode ${mode} in git, so a fresh clone cannot execute it.\n` +
          `    Fix with: git update-index --chmod=+x ${path}`,
      );
    }
  }
} catch {
  console.log('Commands: skipped the executable-bit check (git not available here).');
}

if (problems.length > 0) {
  console.error('Commands that would not work when pasted:\n');
  for (const problem of problems) console.error(`  ${problem}\n`);
  process.exit(1);
}

console.log(
  `Commands OK — ${DOCUMENTS.length} documents scanned, ${ENTRY_POINTS.length} entry points executable.`,
);

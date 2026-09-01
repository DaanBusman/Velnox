#!/usr/bin/env node
/**
 * Reports Dutch documents whose English source has changed since they were
 * translated.
 *
 * docs/i18n.md promises this mechanism, and docs/risks.md R-23 is the risk it
 * addresses: a Dutch document that has silently fallen behind is worse than no
 * translation, because a reader cannot tell.
 *
 * It WARNS and exits 0 by default. English documentation is never held hostage
 * to a pending translation. Pass --strict to fail instead, which is useful
 * before tagging a release.
 *
 * Each translated file declares its source in its header:
 *
 *     > **Vertaling.** Bron: [docs/architecture.md](../architecture.md) @ `5fd136a`.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const translatedDir = join(root, 'docs', 'nl');
const STRICT = process.argv.includes('--strict');

if (!existsSync(translatedDir)) {
  console.warn('No docs/nl directory; nothing to check.');
  process.exit(0);
}

const git = (args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .trim();

try {
  git(['rev-parse', '--git-dir']);
} catch {
  console.warn('Not a git repository; cannot compare translations to their sources.');
  process.exit(0);
}

/** Extract the source path and commit a translation declares in its header. */
function readDeclaration(text) {
  const match = text.match(/Bron:\s*\[([^\]]+)\]\([^)]*\)\s*@\s*`([0-9a-f]{7,40})`/);
  return match ? { source: match[1], commit: match[2] } : null;
}

const stale = [];
const undeclared = [];
const missingSource = [];
let current = 0;

for (const file of readdirSync(translatedDir).filter((f) => f.endsWith('.md'))) {
  const path = join(translatedDir, file);
  const declaration = readDeclaration(readFileSync(path, 'utf8'));

  if (!declaration) {
    undeclared.push(`docs/nl/${file}`);
    continue;
  }

  const sourcePath = declaration.source.replace(/^\/+/, '');
  if (!existsSync(join(root, sourcePath))) {
    missingSource.push(`docs/nl/${file} -> ${sourcePath}`);
    continue;
  }

  let latest;
  try {
    latest = git(['log', '-1', '--format=%h', '--', sourcePath]);
  } catch {
    continue;
  }

  if (!latest) continue;

  // Compare by content: a commit that touched the file without changing it (a
  // rename, a rebase) should not be reported as drift.
  let changed = false;
  try {
    const diff = git(['diff', '--name-only', `${declaration.commit}..HEAD`, '--', sourcePath]);
    changed = diff.length > 0;
  } catch {
    // The recorded commit is unknown to this clone (shallow checkout, or a
    // rewritten history). Reporting that is more useful than guessing.
    stale.push({ file: `docs/nl/${file}`, source: sourcePath, reason: 'unknown source commit' });
    continue;
  }

  if (changed) {
    stale.push({
      file: `docs/nl/${file}`,
      source: sourcePath,
      reason: `${declaration.commit} -> ${latest}`,
    });
  } else {
    current += 1;
  }
}

if (undeclared.length) {
  console.warn(`\nTranslations with no source declaration (${undeclared.length}):`);
  for (const f of undeclared) console.warn(`  - ${f}`);
  console.warn('  Add a header line: > **Vertaling.** Bron: [docs/x.md](../x.md) @ `<commit>`.');
}

if (missingSource.length) {
  console.warn(`\nTranslations whose source no longer exists (${missingSource.length}):`);
  for (const f of missingSource) console.warn(`  - ${f}`);
}

if (stale.length) {
  console.warn(`\nTranslations behind their English source (${stale.length}):`);
  for (const s of stale) console.warn(`  - ${s.file}  (${s.source}: ${s.reason})`);
  console.warn(
    '\n  English is canonical, so this is a warning. Re-translate and update the recorded\n' +
      '  commit, or accept the lag knowingly — but do not let it go unnoticed.',
  );
}

console.warn(
  `\nDoc sync: ${current} current, ${stale.length} behind, ${undeclared.length} undeclared.`,
);

process.exit(STRICT && (stale.length || undeclared.length || missingSource.length) ? 1 : 0);

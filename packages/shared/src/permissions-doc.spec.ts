import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, PRIVILEGED_PERMISSIONS, SYSTEM_ROLES } from './permissions';

/**
 * The documented role matrix has to be the real one.
 *
 * `docs/permissions.md` is now the specification of what every role grants — the
 * Roles & permissions screen points at it instead of listing thirty-four
 * permission chips per role. That makes it something an operator decides access
 * on, which makes a stale table a security problem rather than a documentation
 * problem: nobody re-reads a reference to check whether it is still true.
 *
 * So the table is compared to the catalogue on every run, in both languages. A
 * permission added to a role without updating the docs fails here, at the point
 * the change is made, rather than being discovered by someone who granted a role
 * expecting it to mean what the page said.
 */

const ROOT = join(__dirname, '..', '..', '..');

/** The order of the ✓ columns in the matrix, which is the order of SYSTEM_ROLES. */
const COLUMN_ORDER = SYSTEM_ROLES.map((role) => role.key);

interface Matrix {
  /** Permission -> the role keys marked as granting it. */
  rows: Map<string, string[]>;
}

/**
 * Read the matrix out of a documentation file.
 *
 * Deliberately strict about the shape: a row with the wrong number of cells, or
 * a cell that is neither ✓ nor ·, is a malformed table rather than something to
 * interpret generously. A silently mis-parsed table would pass this test while
 * telling the reader something false.
 */
function parseMatrix(markdown: string, file: string): Matrix {
  const rows = new Map<string, string[]>();
  const lines = markdown.split('\n');

  /*
   * Start at the matrix's own header row and stop at the blank line after it.
   *
   * Scoping matters: the same file carries a second table with one row per
   * permission ("what each permission allows"), and a parser that matched on
   * the row shape alone would read that one too. The column abbreviations are
   * the anchor because they are identical in every translation, so this does not
   * need a per-language heading.
   */
  const start = lines.findIndex((line) => line.includes('| Super |') && line.includes('| T-RO |'));
  if (start === -1) throw new Error(`${file}: the role matrix table is missing`);

  for (const line of lines.slice(start)) {
    if (line.trim() === '') break;

    const match = /^\|\s*`([a-z][a-z_]*\.[a-z][a-z_]*)`\s*\|(.+)\|\s*$/.exec(line.trim());
    const permission = match?.[1];
    const body = match?.[2];
    if (!permission || body === undefined) continue;

    const cells = body.split('|').map((cell) => cell.trim());

    if (cells.length !== COLUMN_ORDER.length) {
      throw new Error(
        `${file}: row for ${permission} has ${cells.length} cells, expected ${COLUMN_ORDER.length}`,
      );
    }

    const granted: string[] = [];
    cells.forEach((cell, index) => {
      const role = COLUMN_ORDER[index];
      if (cell === '✓' && role) granted.push(role);
      else if (cell !== '✓' && cell !== '·') {
        throw new Error(
          `${file}: row for ${permission} has an unreadable cell ${JSON.stringify(cell)}`,
        );
      }
    });

    if (rows.has(permission)) throw new Error(`${file}: ${permission} appears twice`);
    rows.set(permission, granted);
  }

  return { rows };
}

const FILES = ['docs/permissions.md', 'docs/nl/permissions.md'];

describe.each(FILES)('%s', (file) => {
  const markdown = readFileSync(join(ROOT, file), 'utf8');
  const { rows } = parseMatrix(markdown, file);

  it('has a row for every permission in the catalogue, and no others', () => {
    expect([...rows.keys()].sort()).toEqual([...ALL_PERMISSIONS].sort());
  });

  it.each(SYSTEM_ROLES.map((role) => [role.key, role] as const))(
    'documents %s exactly as the catalogue defines it',
    (key, role) => {
      const documented = [...rows.entries()]
        .filter(([, granted]) => granted.includes(key))
        .map(([permission]) => permission)
        .sort();

      expect(documented).toEqual([...role.permissions].sort());
    },
  );

  it('states each role’s permission count correctly in the summary table', () => {
    for (const role of SYSTEM_ROLES) {
      // "| MSP Engineer | `msp_engineer` | yes | 27 | ..." — the count is the
      // cell after the MSP-only column. `34 of 34` on the first row is matched
      // by the same pattern.
      const row = new RegExp(`\`${role.key}\`[^\\n]*`).exec(markdown)?.[0];
      expect(row, `${role.key} is missing from the summary table`).toBeTruthy();
      expect(row, `${role.key} summary row`).toMatch(
        new RegExp(`\\|\\s*${role.permissions.length}(\\s|\\||of)`),
      );
    }
  });

  it('lists exactly the privileged permissions', () => {
    // The section is prose rather than a table, so this checks membership both
    // ways instead of parsing a structure that is not there.
    const from = markdown.indexOf('`REQUIRED_FOR_PRIVILEGED`');
    expect(from, 'the privileged-permissions section is missing').toBeGreaterThan(-1);

    const rest = markdown.slice(from);
    const end = rest.indexOf('\n## ');
    const section = end === -1 ? rest : rest.slice(0, end);

    const listed = new Set(
      [...section.matchAll(/`([a-z][a-z_]*\.[a-z][a-z_]*)`/g)].map((m) => m[1]),
    );

    for (const permission of PRIVILEGED_PERMISSIONS) {
      expect(listed.has(permission), `${permission} is privileged but not listed`).toBe(true);
    }

    // alerts.manage has been mistaken for a privileged permission before; the
    // documentation explains why it is not, so it legitimately appears in the
    // prose. Anything else that is not privileged must not.
    for (const permission of ALL_PERMISSIONS) {
      if (PRIVILEGED_PERMISSIONS.includes(permission)) continue;
      if (permission === 'alerts.manage') continue;
      expect(listed.has(permission), `${permission} is not privileged but is listed as one`).toBe(
        false,
      );
    }
  });
});

#!/usr/bin/env node
/**
 * Bundles the documentation into the product.
 *
 * Velnox is installed on management networks that frequently cannot reach the
 * internet, and the moment an operator most needs the documentation is the
 * moment something is broken — which is a bad time to discover it lives on
 * GitHub. So the docs ship inside the build.
 *
 * This runs before `next build`, reads `docs/*.md` and `docs/nl/*.md`, converts
 * them to HTML, and writes one generated module the web app imports. Because it
 * runs in the same build that stamps the version, the documentation and the
 * software it describes can never be a release apart: every page states the
 * version it was built from, and that string comes from the same place the
 * running binary reports.
 *
 * The generated file is not committed. It is a build product of two inputs that
 * are, and committing it would create a third thing to keep in step.
 */

import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

// apps/web/scripts -> repository root.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OUT = join(ROOT, 'apps/web/generated/docs.json');

/**
 * Which documents ship, and in what order.
 *
 * An explicit list rather than whatever the directory happens to contain: the
 * order is the reading order for someone who has just installed this and does
 * not know where to start, and a new document should be placed deliberately.
 */
const DOCUMENTS = [
  'deployment',
  'architecture',
  'service-diagram',
  'database-schema',
  'tech-decisions',
  'roadmap',
  'known-gaps',
  'risks',
  'i18n',
];

const LOCALES = [
  { locale: 'en', dir: 'docs' },
  { locale: 'nl', dir: 'docs/nl' },
];

/**
 * The documents are first-party files, reviewed in diffs like any other source.
 * That is what makes rendering them as HTML acceptable — but "we would notice"
 * is not a control, so the build refuses anything that could execute. If a
 * document ever legitimately needs raw HTML, this is the line to come and argue
 * with.
 */
const DANGEROUS = [
  { pattern: /<script\b/i, what: 'a <script> tag' },
  { pattern: /<iframe\b/i, what: 'an <iframe> tag' },
  { pattern: /\son[a-z]+\s*=/i, what: 'an inline event handler' },
  { pattern: /javascript:/i, what: 'a javascript: URL' },
];

function assertSafe(file, markdown) {
  for (const { pattern, what } of DANGEROUS) {
    if (pattern.test(markdown)) {
      throw new Error(
        `${file} contains ${what}. Documentation is rendered as HTML, so this is refused. ` +
          'Remove it, or change scripts/build-docs.mjs deliberately.',
      );
    }
  }
}

/** The first `# heading`, which is what the document calls itself. */
function extractTitle(markdown, slug) {
  const heading = /^#\s+(.+)$/m.exec(markdown);
  return heading?.[1]?.trim() ?? slug;
}

/**
 * The `##` headings, for an on-page table of contents.
 *
 * Anchor ids are generated the same way here and in the renderer below, so a
 * contents link and the heading it points at cannot disagree.
 */
function slugifyHeading(text) {
  return text
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

function extractHeadings(markdown) {
  const headings = [];
  // Skip fenced code, where a "## " line is code and not a heading.
  const withoutCode = markdown.replace(/```[\s\S]*?```/g, '');

  for (const match of withoutCode.matchAll(/^##\s+(.+)$/gm)) {
    const text = match[1].trim().replace(/[`*_]/g, '');
    headings.push({ id: slugifyHeading(text), text });
  }
  return headings;
}

/**
 * Rewrites links between documents so they work inside the app.
 *
 * The markdown is written to be read on GitHub, where `docs/roadmap.md` and
 * `../known-gaps.md` are correct. In here those are 404s. Anything that is not
 * a link to another bundled document is left exactly as it was — an external
 * URL still points outside, and is marked as such by the renderer.
 */
function rewriteLink(href) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return null; // absolute
  if (href.startsWith('#')) return href; // same page

  const [path, fragment] = href.split('#');
  const match = /([^/]+)\.md$/.exec(path ?? '');
  if (!match) return null;

  const slug = match[1];
  if (!DOCUMENTS.includes(slug)) return null;

  // The app has no locale segment in its URLs — the reader's language comes
  // from their cookie — so one path serves both translations.
  return `/docs/${slug}${fragment ? `#${fragment}` : ''}`;
}

function render(markdown) {
  const renderer = new marked.Renderer();

  renderer.heading = ({ text, depth }) => {
    const plain = text.replace(/<[^>]+>/g, '');
    const id = slugifyHeading(plain);
    // The id is what an in-page anchor targets; scroll-margin keeps a linked
    // heading clear of anything sticky above it.
    return `<h${depth} id="${id}" class="velnox-heading">${text}</h${depth}>`;
  };

  renderer.link = ({ href, title, tokens }) => {
    const text = renderer.parser.parseInline(tokens);
    const internal = rewriteLink(href);

    if (internal) {
      return `<a href="${internal}"${title ? ` title="${title}"` : ''}>${text}</a>`;
    }

    const isExternal = /^https?:/i.test(href);
    // An external link leaves the appliance, which on an isolated management
    // network usually means it will not open at all. Saying so beats a dead
    // click.
    return isExternal
      ? `<a href="${href}" target="_blank" rel="noopener noreferrer" class="velnox-external"${
          title ? ` title="${title}"` : ''
        }>${text}</a>`
      : `<a href="${href}"${title ? ` title="${title}"` : ''}>${text}</a>`;
  };

  return marked.parse(markdown, { renderer, gfm: true, breaks: false, async: false });
}

function build() {
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const documents = [];

  for (const { locale, dir } of LOCALES) {
    const available = new Set(
      readdirSync(join(ROOT, dir))
        .filter((name) => name.endsWith('.md'))
        .map((name) => name.replace(/\.md$/, '')),
    );

    for (const slug of DOCUMENTS) {
      if (!available.has(slug)) {
        // A missing translation is normal and is reported to the reader at the
        // top of the page, not hidden by silently serving English under a Dutch
        // heading.
        continue;
      }

      const file = join(dir, `${slug}.md`);
      const markdown = readFileSync(join(ROOT, file), 'utf8');
      assertSafe(file, markdown);

      documents.push({
        slug,
        locale,
        title: extractTitle(markdown, slug),
        headings: extractHeadings(markdown),
        html: render(markdown),
        source: file,
      });
    }
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    `${JSON.stringify({ version, generatedAt: new Date().toISOString(), order: DOCUMENTS, documents }, null, 2)}\n`,
  );

  const byLocale = LOCALES.map(
    ({ locale }) => `${locale}: ${documents.filter((d) => d.locale === locale).length}`,
  ).join(', ');
  console.log(`Documentation bundled for v${version} — ${byLocale}.`);
}

build();

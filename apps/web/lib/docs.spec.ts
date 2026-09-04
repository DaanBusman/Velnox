import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOCS_VERSION, DOC_SLUGS, getDoc, listDocs } from './docs';

/**
 * The documentation bundle.
 *
 * The promise printed on every page — "This Documentation applies to version
 * V0.2.0" — is only worth anything if that string comes from the same place the
 * running software gets its version. These tests are what keep it from becoming
 * a label someone forgot to change.
 */

const repoRoot = join(__dirname, '..', '..', '..');
const packageVersion = JSON.parse(
  readFileSync(join(repoRoot, 'package.json'), 'utf8'),
).version as string;

describe('documentation bundle', () => {
  it('is stamped with the version in the root package.json', () => {
    // If this fails, the bundle was built before the version was bumped and the
    // banner on every page is a release behind.
    expect(DOCS_VERSION).toBe(packageVersion);
  });

  it('contains the documents it claims to', () => {
    expect(DOC_SLUGS.length).toBeGreaterThan(5);
    expect(DOC_SLUGS).toContain('deployment');
    expect(DOC_SLUGS).toContain('known-gaps');
  });

  it('gives every document a title and a body', () => {
    for (const slug of DOC_SLUGS) {
      const doc = getDoc(slug, 'en');
      expect(doc, slug).not.toBeNull();
      expect(doc!.page.title.length, slug).toBeGreaterThan(0);
      // A document that rendered to almost nothing means the converter silently
      // produced an empty page rather than failing.
      expect(doc!.page.html.length, slug).toBeGreaterThan(200);
    }
  });

  it('serves Dutch where a translation exists, and says so where it does not', () => {
    for (const { page, fellBackToEnglish } of listDocs('nl')) {
      if (fellBackToEnglish) {
        expect(page.locale).toBe('en');
      } else {
        expect(page.locale).toBe('nl');
      }
    }
  });

  it('falls back to English rather than returning nothing', () => {
    // A reader in a language with no translations must still get the document.
    const doc = getDoc('deployment', 'de');
    expect(doc).not.toBeNull();
    expect(doc!.page.locale).toBe('en');
    expect(doc!.fellBackToEnglish).toBe(true);
  });

  it('returns null for a slug that does not exist', () => {
    expect(getDoc('not-a-document', 'en')).toBeNull();
  });

  it('rewrites links between documents to routes this app serves', () => {
    const withLinks = DOC_SLUGS.map((slug) => getDoc(slug, 'en')!.page).filter((page) =>
      page.html.includes('href="/docs/'),
    );

    expect(withLinks.length).toBeGreaterThan(0);

    for (const page of withLinks) {
      for (const match of page.html.matchAll(/href="\/docs\/([^"#]+)/g)) {
        // A rewritten link that points at a document the bundle does not carry
        // is a 404 shipped inside the product.
        expect(DOC_SLUGS, `${page.slug} links to ${match[1]}`).toContain(match[1]);
      }
    }
  });

  it('carries no link to a markdown file, which would 404 in the app', () => {
    for (const slug of DOC_SLUGS) {
      const html = getDoc(slug, 'en')!.page.html;
      const stray = [...html.matchAll(/href="([^"]*\.md[^"]*)"/g)]
        .map((m) => m[1])
        .filter((href): href is string => href !== undefined);
      // Links to documents that are not bundled (the README, say) stay as
      // written; what must not happen is a link to a bundled document keeping
      // its .md extension.
      for (const href of stray) {
        expect(
          DOC_SLUGS.some((known) => href.endsWith(`${known}.md`)),
          `${slug} still links to ${href}`,
        ).toBe(false);
      }
    }
  });

  it('contains nothing executable', () => {
    // The build script refuses these; this asserts the refusal actually held.
    for (const slug of DOC_SLUGS) {
      for (const locale of ['en', 'nl']) {
        const doc = getDoc(slug, locale);
        if (!doc) continue;
        expect(doc.page.html).not.toMatch(/<script/i);
        expect(doc.page.html).not.toMatch(/\son[a-z]+\s*=/i);
        expect(doc.page.html).not.toMatch(/javascript:/i);
      }
    }
  });
});

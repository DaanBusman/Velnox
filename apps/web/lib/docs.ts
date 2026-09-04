import bundle from '@/generated/docs.json';

/**
 * The documentation that ships inside the build.
 *
 * `generated/docs.json` is written by `scripts/build-docs.mjs` immediately
 * before every build, from `docs/*.md` and `docs/nl/*.md`, and stamped with the
 * version out of the root package.json — the same string the API reports for the
 * running build. That is what makes the promise on every page true rather than
 * decorative: the documentation and the software were produced by one build, so
 * they cannot describe different releases.
 *
 * Importing it as JSON means it is part of the bundle, so it works on an
 * appliance with no route to the internet, which is the situation this exists
 * for.
 */

export interface DocHeading {
  id: string;
  text: string;
}

export interface DocPage {
  slug: string;
  locale: string;
  title: string;
  headings: DocHeading[];
  html: string;
  /** Where it came from in the repository, so a reader can find the original. */
  source: string;
}

interface DocBundle {
  version: string;
  generatedAt: string;
  order: string[];
  documents: DocPage[];
}

const docs = bundle as DocBundle;

/** The version the documentation was built from. */
export const DOCS_VERSION = docs.version;
export const DOCS_GENERATED_AT = docs.generatedAt;

/** Every slug, in reading order rather than alphabetical. */
export const DOC_SLUGS: string[] = docs.order.filter((slug) =>
  docs.documents.some((doc) => doc.slug === slug),
);

export interface ResolvedDoc {
  page: DocPage;
  /**
   * True when the reader's language has no translation of this document and
   * English was served instead. The page says so rather than quietly switching
   * language under a Dutch heading.
   */
  fellBackToEnglish: boolean;
}

export function getDoc(slug: string, locale: string): ResolvedDoc | null {
  const translated = docs.documents.find((doc) => doc.slug === slug && doc.locale === locale);
  if (translated) return { page: translated, fellBackToEnglish: false };

  const english = docs.documents.find((doc) => doc.slug === slug && doc.locale === 'en');
  if (!english) return null;

  return { page: english, fellBackToEnglish: locale !== 'en' };
}

/** The index, in the reader's language where one exists. */
export function listDocs(locale: string): ResolvedDoc[] {
  return DOC_SLUGS.map((slug) => getDoc(slug, locale)).filter(
    (doc): doc is ResolvedDoc => doc !== null,
  );
}

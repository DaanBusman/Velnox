import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { DocVersionBanner } from '@/components/doc-version-banner';
import { Notice, PageHeader } from '@/components/ui/primitives';
import { getDoc } from '@/lib/docs';

export const dynamic = 'force-dynamic';

/*
 * Deliberately no generateStaticParams.
 *
 * The reader's language comes from a cookie, so prerendering these at build time
 * would freeze whichever locale the build happened to resolve and serve it to
 * everyone. The documents are already in memory — rendering per request costs
 * nothing worth having.
 */

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const locale = await getLocale();
  const doc = getDoc(slug, locale);
  return { title: doc?.page.title ?? slug };
}

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [locale, t] = await Promise.all([getLocale(), getTranslations()]);

  const doc = getDoc(slug, locale);
  if (!doc) notFound();

  const { page, fellBackToEnglish } = doc;

  return (
    <>
      <PageHeader
        title={page.title}
        actions={
          <Link href="/docs" className="text-xs text-ink-muted underline hover:text-ink">
            {t('docs.backToIndex')}
          </Link>
        }
      />

      <div className="space-y-5">
        <DocVersionBanner />

        {fellBackToEnglish && (
          <Notice tone="neutral" title={t('docs.notTranslatedTitle')}>
            {t('docs.notTranslatedBody')}
          </Notice>
        )}

        {page.headings.length > 2 && (
          <nav aria-label={t('docs.onThisPage')} className="rounded border border-line bg-surface-2 px-4 py-3">
            <p className="text-xs font-medium text-ink">{t('docs.onThisPage')}</p>
            <ul className="mt-1.5 space-y-1">
              {page.headings.map((heading) => (
                <li key={heading.id}>
                  <a href={`#${heading.id}`} className="text-xs text-ink-muted hover:text-ink">
                    {heading.text}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        )}

        {/*
          The HTML comes from a markdown file in this repository, converted at
          build time by a script that refuses scripts, iframes, inline event
          handlers and javascript: URLs outright. It is first-party content that
          went through review like any other source file — not anything a user
          supplied.
        */}
        <article className="velnox-prose" dangerouslySetInnerHTML={{ __html: page.html }} />

        <p className="text-xs text-ink-muted">{t('docs.sourceFile', { file: page.source })}</p>
      </div>
    </>
  );
}

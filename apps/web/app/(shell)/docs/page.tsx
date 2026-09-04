import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { DocVersionBanner } from '@/components/doc-version-banner';
import { Card, PageHeader } from '@/components/ui/primitives';
import { listDocs } from '@/lib/docs';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('nav.documentation') };
}

/**
 * The documentation index.
 *
 * Ordered for reading rather than alphabetically: someone who has just installed
 * this needs deployment first and the localization guide last.
 */
export default async function DocsIndexPage() {
  const [locale, t] = await Promise.all([getLocale(), getTranslations()]);
  const docs = listDocs(locale);

  return (
    <>
      <PageHeader title={t('nav.documentation')} description={t('docs.subtitle')} />

      <div className="space-y-5">
        <DocVersionBanner />

        <Card title={t('docs.availableOffline')} description={t('docs.availableOfflineBody')}>
          <ul className="divide-y divide-line">
            {docs.map(({ page, fellBackToEnglish }) => (
              <li key={page.slug} className="py-2 first:pt-0 last:pb-0">
                <Link
                  href={`/docs/${page.slug}`}
                  className="text-sm font-medium text-ink hover:underline"
                >
                  {page.title}
                </Link>
                {fellBackToEnglish && (
                  <span className="ml-2 text-xs text-ink-muted">{t('docs.englishOnly')}</span>
                )}
                {page.headings.length > 0 && (
                  <p className="mt-0.5 truncate text-xs text-ink-muted">
                    {page.headings
                      .slice(0, 4)
                      .map((heading) => heading.text)
                      .join(' · ')}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}

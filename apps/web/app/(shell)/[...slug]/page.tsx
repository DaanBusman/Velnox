import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { findNavItem } from '@/lib/nav';
import { Notice, PageHeader } from '@/components/ui/primitives';
import { tryGetSystemInfo } from '@/lib/api';

interface Props {
  params: Promise<{ slug: string[] }>;
}

const hrefFrom = (slug: string[]): string => `/${slug.join('/')}`;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const item = findNavItem(hrefFrom(slug));
  if (!item) return {};
  const t = await getTranslations();
  return { title: t(`nav.${item.key}`) };
}

/**
 * Placeholder for navigation destinations whose phase has not landed.
 *
 * Deliberately not a mock-up. It states which phase implements the section and
 * shows nothing else, because sample data in an infrastructure tool teaches
 * operators to trust a screen that is lying to them.
 *
 * Anything that is not a known destination 404s, so the placeholder cannot mask
 * a broken link.
 */
export default async function PlaceholderPage({ params }: Props) {
  const { slug } = await params;
  const item = findNavItem(hrefFrom(slug));
  if (!item || item.phase === null) notFound();

  const [t, info] = await Promise.all([getTranslations(), tryGetSystemInfo()]);
  const product = info?.product ?? 'Velnox';

  return (
    <>
      <PageHeader
        title={t(`nav.${item.key}`)}
        description={t('placeholder.plannedIn', { phase: item.phase })}
      />

      <Notice tone="neutral" title={t('placeholder.notBuiltYet')}>
        <p>{t('placeholder.body', { product })}</p>
        <p className="mt-2">{t('placeholder.seeRoadmap')}</p>
        <p className="mt-3">
          <Link href="/" className="text-accent underline underline-offset-2">
            {t('placeholder.backToDashboard')}
          </Link>
        </p>
      </Notice>
    </>
  );
}

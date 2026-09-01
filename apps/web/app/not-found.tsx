import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Notice, PageHeader } from '@/components/ui/primitives';

export default async function NotFound() {
  const t = await getTranslations();

  return (
    <>
      <PageHeader title="404" />
      <Notice tone="neutral">
        <p>{t('errors.not_found')}</p>
        <p className="mt-3">
          <Link href="/" className="text-accent underline underline-offset-2">
            {t('placeholder.backToDashboard')}
          </Link>
        </p>
      </Notice>
    </>
  );
}

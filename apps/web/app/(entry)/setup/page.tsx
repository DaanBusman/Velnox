import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { SetupForm } from '@/components/setup-form';
import { Notice } from '@/components/ui/primitives';
import { getSetupStatus } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const status = await getSetupStatus();
  const t = await getTranslations();
  return { title: t('setup.title', { product: status?.productName ?? 'Velnox' }) };
}

export default async function SetupPage() {
  const [status, t] = await Promise.all([getSetupStatus(), getTranslations()]);

  // Setup runs exactly once. The API returns 409 on a second attempt regardless,
  // so this redirect is about not showing a form that cannot work.
  if (status?.initialized) redirect('/login');

  if (!status) {
    return (
      <Notice tone="error" title={t('auth.apiUnreachableTitle')}>
        {t('auth.apiUnreachableBody')}
      </Notice>
    );
  }

  return <SetupForm product={status.productName} />;
}

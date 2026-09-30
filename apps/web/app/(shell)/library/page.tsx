import { getTranslations } from 'next-intl/server';
import { Notice, PageHeader } from '@/components/ui/primitives';
import { LibraryView } from '@/components/library/library-view';
import { getSession, listLibrary } from '@/lib/session';
import { refreshSeconds } from '@/lib/preferences';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('nav.library') };
}

export default async function LibraryPage() {
  const [t, session, library, refresh] = await Promise.all([
    getTranslations(),
    getSession(),
    listLibrary(),
    refreshSeconds(),
  ]);

  const permissions = new Set(session?.user.permissions ?? []);

  return (
    <>
      <PageHeader title={t('nav.library')} description={t('library.subtitle')} />
      {library.ok ? (
        <LibraryView
          data={library.data}
          canManage={permissions.has('library.manage')}
          canPush={permissions.has('clusters.manage')}
          refreshSeconds={refresh}
        />
      ) : (
        <Notice tone={library.code === 'authz.forbidden' ? 'warn' : 'error'}>
          {library.code === 'authz.forbidden'
            ? t('common.requiresPermission', { permission: 'library.read' })
            : t('errors.generic')}
        </Notice>
      )}
    </>
  );
}

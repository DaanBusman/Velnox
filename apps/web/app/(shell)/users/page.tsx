import { getTranslations } from 'next-intl/server';
import { Notice, PageHeader } from '@/components/ui/primitives';
import { UserAdmin } from '@/components/user-admin';
import { getSession, listRoles, listUsers } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('nav.users') };
}

export default async function UsersPage() {
  const [t, session, users, roles] = await Promise.all([
    getTranslations(),
    getSession(),
    listUsers(),
    listRoles(),
  ]);

  if (!users.ok) {
    return (
      <>
        <PageHeader title={t('nav.users')} />
        <Notice tone={users.code === 'authz.forbidden' ? 'warn' : 'error'}>
          {users.code === 'authz.forbidden'
            ? t('common.requiresPermission', { permission: 'users.read' })
            : t('errors.generic')}
        </Notice>
      </>
    );
  }

  /*
   * Which controls to show comes from the permissions the API reported for this
   * session, not from a guess. Showing a button that always fails is worse than
   * not showing it, and the API refuses the call either way — this only decides
   * what is worth offering.
   */
  const permissions = new Set(session?.user.permissions ?? []);
  const canManageUsers = permissions.has('users.manage');
  const canManageRoles = permissions.has('roles.manage');

  /*
   * Recommending a second factor to the accounts that most need one.
   *
   * `privileged` is computed by the API from the permissions an account actually
   * holds — not from a role name, which can be renamed.
   */
  const unprotected = users.data.users.filter((user) => user.privileged && !user.mfaEnrolled);

  return (
    <>
      <PageHeader title={t('nav.users')} description={t('users.subtitle')} />

      <div className="space-y-5">
        {unprotected.length > 0 && (
          <Notice tone="warn" title={t('users.mfaGapTitle', { count: unprotected.length })}>
            <p>{t('auth.mfaRecommended')}</p>
            <p className="mt-1 text-ink">{unprotected.map((user) => user.email).join(', ')}</p>
          </Notice>
        )}

        <UserAdmin
          users={users.data.users}
          roles={roles.ok ? roles.data.roles : []}
          canManageUsers={canManageUsers}
          canManageRoles={canManageRoles && roles.ok}
          currentUserId={session?.user.id ?? null}
        />
      </div>
    </>
  );
}

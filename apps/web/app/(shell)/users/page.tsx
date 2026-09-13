import { getTranslations } from 'next-intl/server';
import { Notice, PageHeader } from '@/components/ui/primitives';
import { UserAdmin } from '@/components/user-admin';
import { getSession, listRoles, listSites, listTenants, listUsers } from '@/lib/session';
import { resolveSelection, selectedTenantId } from '@/lib/tenant-selection';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('nav.users') };
}

export default async function UsersPage() {
  const [t, session, roles, tenants, selected] = await Promise.all([
    getTranslations(),
    getSession(),
    listRoles(),
    listTenants(),
    selectedTenantId(),
  ]);

  /*
   * The tenant selector in the top bar narrows this page.
   *
   * Resolved against the tenants this account can actually reach, so a cookie
   * left behind by an archived customer shows an empty list for a visible
   * reason rather than for none at all. Selecting the MSP organisation shows
   * only MSP accounts, which is the whole point of the control.
   */
  const selectable = tenants.ok ? tenants.data.tenants : [];
  const tenantId = resolveSelection(selected, selectable);

  const [users, sites] = await Promise.all([listUsers(tenantId), listSites()]);

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
   * Two permissions, not one. `users.reset_mfa` reaches a customer's account;
   * reaching one in the MSP organisation additionally needs
   * `users.reset_mfa_msp`, which only the Super Administrator holds. Both are
   * passed down so the row can say why a button is absent instead of simply
   * omitting it.
   */
  const canResetMfa = permissions.has('users.reset_mfa');
  const canResetMfaMsp = permissions.has('users.reset_mfa_msp');

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
          tenants={selectable}
          sites={sites.ok ? sites.data.sites : []}
          canManageUsers={canManageUsers}
          canManageRoles={canManageRoles && roles.ok}
          canResetMfa={canResetMfa}
          canResetMfaMsp={canResetMfaMsp}
          currentUserId={session?.user.id ?? null}
        />
      </div>
    </>
  );
}

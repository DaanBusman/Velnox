import { getFormatter, getTranslations } from 'next-intl/server';
import { Card, Notice, PageHeader, StatusBadge } from '@/components/ui/primitives';
import { getSession, listUsers } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('nav.users') };
}

export default async function UsersPage() {
  const [t, format, session, result] = await Promise.all([
    getTranslations(),
    getFormatter(),
    getSession(),
    listUsers(),
  ]);

  if (!result.ok) {
    return (
      <>
        <PageHeader title={t('nav.users')} />
        <Notice tone={result.code === 'authz.forbidden' ? 'warn' : 'error'}>
          {result.code === 'authz.forbidden'
            ? t('common.requiresPermission', { permission: 'users.read' })
            : t('errors.generic')}
        </Notice>
      </>
    );
  }

  /*
   * Recommending a second factor to the accounts that need one most.
   *
   * `privileged` comes from the API, which computes it from the permissions the
   * account actually holds — not from a role name, which can be renamed, and not
   * from a guess made here.
   */
  const unprotected = result.users.filter((user) => user.privileged && !user.mfaEnrolled);

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

        <Card title={t('users.listTitle', { count: result.users.length })}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-ink-muted">
                  <th className="py-2 pr-4 font-medium">{t('users.columnName')}</th>
                  <th className="py-2 pr-4 font-medium">{t('users.columnRoles')}</th>
                  <th className="py-2 pr-4 font-medium">{t('users.columnMfa')}</th>
                  <th className="py-2 pr-4 font-medium">{t('users.columnLastLogin')}</th>
                </tr>
              </thead>
              <tbody>
                {result.users.map((user) => (
                  <tr key={user.id} className="border-b border-line last:border-b-0 align-top">
                    <td className="py-2 pr-4">
                      <div className="font-medium text-ink">
                        {user.displayName}
                        {user.id === session?.user.id && (
                          <span className="ml-2 text-xs font-normal text-ink-muted">
                            {t('users.you')}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-ink-muted">{user.email}</div>
                    </td>
                    <td className="py-2 pr-4 text-xs text-ink-muted">
                      {user.roles.length > 0 ? user.roles.join(', ') : '—'}
                    </td>
                    <td className="py-2 pr-4">
                      {user.mfaEnrolled ? (
                        <StatusBadge tone="ok">{t('mfa.badgeEnrolled')}</StatusBadge>
                      ) : (
                        <StatusBadge tone={user.privileged ? 'warn' : 'neutral'}>
                          {t('mfa.badgeNotEnrolled')}
                        </StatusBadge>
                      )}
                    </td>
                    <td className="py-2 pr-4 text-xs text-ink-muted">
                      {user.lastLoginAt
                        ? format.dateTime(new Date(user.lastLoginAt), {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          })
                        : t('common.never')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Notice tone="neutral" title={t('users.managementPendingTitle')}>
          {t('users.managementPendingBody')}
        </Notice>
      </div>
    </>
  );
}

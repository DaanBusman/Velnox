import { getTranslations } from 'next-intl/server';
import { Card, Notice, PageHeader, StatusBadge } from '@/components/ui/primitives';
import { listRoles } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('nav.rolesPermissions') };
}

/**
 * What each role grants.
 *
 * Read from the database rather than the catalogue, so a role that was edited is
 * shown as it is. Permissions are listed in full rather than summarised — the
 * point of this page is answering "what can someone with this role actually do",
 * and a count does not answer it.
 */
export default async function RolesPage() {
  const [t, result] = await Promise.all([getTranslations(), listRoles()]);

  if (!result.ok) {
    return (
      <>
        <PageHeader title={t('nav.rolesPermissions')} />
        <Notice tone={result.code === 'authz.forbidden' ? 'warn' : 'error'}>
          {result.code === 'authz.forbidden'
            ? t('common.requiresPermission', { permission: 'roles.read' })
            : t('errors.generic')}
        </Notice>
      </>
    );
  }

  const { roles, catalogue } = result.data;

  return (
    <>
      <PageHeader title={t('nav.rolesPermissions')} description={t('roles.subtitle')} />

      <div className="space-y-5">
        <Notice tone="neutral" title={t('roles.systemRolesTitle')}>
          {t('roles.systemRolesBody', { count: catalogue.length })}
        </Notice>

        {roles.map((role) => (
          <Card
            key={role.id}
            title={role.name}
            description={role.description ?? undefined}
            actions={
              <div className="flex items-center gap-2">
                {role.mspOnly && <StatusBadge tone="neutral">{t('roles.mspOnly')}</StatusBadge>}
                <StatusBadge tone={role.assignmentCount > 0 ? 'ok' : 'neutral'}>
                  {t('roles.assigned', { count: role.assignmentCount })}
                </StatusBadge>
              </div>
            }
          >
            {role.permissions.length === 0 ? (
              <p className="text-sm text-ink-muted">{t('roles.noPermissions')}</p>
            ) : (
              <ul className="flex flex-wrap gap-1.5">
                {role.permissions.map((permission) => (
                  <li
                    key={permission}
                    className="rounded bg-surface-2 px-2 py-0.5 font-mono text-xs text-ink"
                  >
                    {permission}
                  </li>
                ))}
              </ul>
            )}

            {/* Surfaced rather than hidden: a stored permission this build does
                not know grants nothing, but it means the database and the code
                disagree, which someone should see. */}
            {role.unknownPermissions.length > 0 && (
              <div className="mt-3">
                <Notice tone="warn" title={t('roles.unknownTitle')}>
                  {role.unknownPermissions.join(', ')}
                </Notice>
              </div>
            )}
          </Card>
        ))}

        <Notice tone="neutral" title={t('roles.editingPendingTitle')}>
          {t('roles.editingPendingBody')}
        </Notice>
      </div>
    </>
  );
}

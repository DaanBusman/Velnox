import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Card, Notice, PageHeader, StatusBadge } from '@/components/ui/primitives';
import { listRoles } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('nav.rolesPermissions') };
}

/**
 * The resource half of `resource.action`.
 *
 * Grouping by it is what turns thirty-four permission names into a sentence a
 * person can hold in their head: this role changes clusters, nodes and updates.
 */
const resourceOf = (permission: string) => permission.split('.')[0];

/** Everything that is not `.read` — the permissions that alter something. */
const isWrite = (permission: string) => !permission.endsWith('.read');

/**
 * What each role grants, as an overview.
 *
 * This page used to print every permission of every role as a chip, which for a
 * Super Administrator is thirty-four of them and for the page as a whole is over
 * two hundred — a wall that answers "what can this role do" only for someone
 * already willing to read the whole catalogue. The specification moved to the
 * documentation, where it can be a proper matrix with the reasoning next to it,
 * and this page answers the question an administrator actually arrives with:
 * which of these roles changes things, and what kind of things.
 *
 * The full list is still here, one disclosure away. Nothing was removed — and it
 * still comes from the database rather than the catalogue, so a role that was
 * edited is shown as it is rather than as it shipped.
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
        <Notice tone="neutral" title={t('roles.referenceTitle')}>
          {t('roles.referenceBody')}{' '}
          <Link href="/docs/permissions" className="font-medium underline">
            {t('roles.referenceLink')}
          </Link>
        </Notice>

        <Notice tone="neutral" title={t('roles.systemRolesTitle')}>
          {t('roles.systemRolesBody', { count: catalogue.length })}
        </Notice>

        {roles.map((role) => {
          const changes = [...new Set(role.permissions.filter(isWrite).map(resourceOf))].sort();

          return (
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
                <>
                  <p className="text-sm text-ink-muted">
                    {t('roles.permissionCount', {
                      granted: role.permissions.length,
                      total: catalogue.length,
                    })}
                  </p>

                  {/* The one line worth reading. A role that changes nothing is
                      a materially different thing from one that changes six
                      kinds of resource, and that distinction was invisible in a
                      list of thirty-four names. */}
                  <div className="mt-2 flex flex-wrap items-baseline gap-1.5">
                    {changes.length === 0 ? (
                      <StatusBadge tone="ok">{t('roles.readOnlyRole')}</StatusBadge>
                    ) : (
                      <>
                        <span className="text-sm font-medium text-ink">
                          {t('roles.canChange')}
                        </span>
                        {changes.map((resource) => (
                          <span
                            key={resource}
                            className="rounded bg-surface-2 px-2 py-0.5 font-mono text-xs text-ink"
                          >
                            {resource}
                          </span>
                        ))}
                      </>
                    )}
                  </div>

                  <details className="mt-3 border-t border-line pt-3">
                    <summary className="cursor-pointer text-xs text-ink-muted hover:text-ink">
                      {t('roles.showAll', { count: role.permissions.length })}
                    </summary>
                    <ul className="mt-2 flex flex-wrap gap-1.5">
                      {role.permissions.map((permission) => (
                        <li
                          key={permission}
                          className="rounded bg-surface-2 px-2 py-0.5 font-mono text-xs text-ink"
                        >
                          {permission}
                        </li>
                      ))}
                    </ul>
                  </details>
                </>
              )}

              {/* Surfaced rather than hidden: a stored permission this build does
                  not know grants nothing, but it means the database and the code
                  disagree, which someone should see. Never behind a disclosure. */}
              {role.unknownPermissions.length > 0 && (
                <div className="mt-3">
                  <Notice tone="warn" title={t('roles.unknownTitle')}>
                    {role.unknownPermissions.join(', ')}
                  </Notice>
                </div>
              )}
            </Card>
          );
        })}

        <Notice tone="neutral" title={t('roles.editingPendingTitle')}>
          {t('roles.editingPendingBody')}
        </Notice>
      </div>
    </>
  );
}

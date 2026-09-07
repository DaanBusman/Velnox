'use client';

import { useRouter } from 'next/navigation';
import { Fragment, useMemo, useState, type FormEvent } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import type { RoleSummary, UserSummary } from '@/lib/session-types';
import { apiDelete, apiPatch, apiPost, type ApiFailure } from '@/lib/client-api';
import { useApiError } from '@/lib/use-api-error';
import { Button, Field, FormError, TextInput } from '@/components/ui/form';
import { Card, Notice, StatusBadge } from '@/components/ui/primitives';

const PASSWORD_MIN_LENGTH = 12;

/** The tenant filter's "everyone" option. Not a tenant id, so it cannot collide with one. */
const ALL_TENANTS = '';

/**
 * Whether disabling this account would leave nobody able to administer anything.
 *
 * Only the founding administrator can reach that state, because only their roles
 * cannot be taken away. The API refuses it regardless; hiding the button keeps
 * someone from discovering the rule by being refused.
 */
function isLastWayIn(user: UserSummary, users: UserSummary[]): boolean {
  if (!user.isFoundingAdministrator) return false;
  return !users.some(
    (other) => other.id !== user.id && other.status === 'ACTIVE' && other.privileged,
  );
}

/**
 * Whether to offer the second-factor reset for this account.
 *
 * The same three rules the API enforces in `canResetMfa`, in the same order.
 * Duplicated deliberately rather than shared: this decides what to *offer*, and
 * the API decides what to *allow* — a button hidden here is a courtesy, and a
 * request made by other means is refused there regardless.
 */
function canOfferMfaReset(
  user: UserSummary,
  currentUserId: string | null,
  permissions: { resetMfa: boolean; resetMfaMsp: boolean },
): boolean {
  if (user.id === currentUserId) return false;
  if (!permissions.resetMfa) return false;
  if (user.tenantIsMspRoot && !permissions.resetMfaMsp) return false;
  return true;
}

/**
 * Accounts, as a table.
 *
 * This was a stack of cards, one per account, each carrying its roles, its
 * badges and its buttons. That reads well for the three accounts a new
 * installation has and stops reading at twenty: scanning "who is disabled" or
 * "who has no second factor" meant reading every card in full, because the
 * answer was in a different place in each one.
 *
 * So the overview is a table with a fixed column per question, scrolling under a
 * sticky header, and everything that only matters for one account — its roles,
 * the grant control, why a button is missing — lives in a row you expand. The
 * filters above it are the two that actually narrow a real list: which tenant,
 * and a name.
 *
 * Everything here is enforced again by the API, which checks the permission and
 * the tenant on every call. What this component controls is whether a person is
 * shown a control they cannot use.
 */
export function UserAdmin({
  users,
  roles,
  canManageUsers,
  canManageRoles,
  canResetMfa,
  canResetMfaMsp,
  currentUserId,
}: {
  users: UserSummary[];
  roles: RoleSummary[];
  canManageUsers: boolean;
  canManageRoles: boolean;
  canResetMfa: boolean;
  canResetMfaMsp: boolean;
  currentUserId: string | null;
}) {
  const t = useTranslations();
  const format = useFormatter();
  const router = useRouter();
  const describeError = useApiError();

  const [creating, setCreating] = useState(false);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const [tenantFilter, setTenantFilter] = useState<string>(ALL_TENANTS);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  /**
   * The tenants present in the list, MSP organisation first.
   *
   * Derived from the accounts rather than fetched: this list is exactly the
   * tenants the viewer is allowed to see, so it cannot offer a filter that
   * returns nothing or hint at the existence of a tenant they cannot read.
   */
  const tenants = useMemo(() => {
    const byId = new Map<string, { id: string; name: string; isMspRoot: boolean }>();
    for (const user of users) {
      if (!byId.has(user.tenantId)) {
        byId.set(user.tenantId, {
          id: user.tenantId,
          name: user.tenantName,
          isMspRoot: user.tenantIsMspRoot,
        });
      }
    }
    return [...byId.values()].sort((a, b) => {
      if (a.isMspRoot !== b.isMspRoot) return a.isMspRoot ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [users]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return users.filter((user) => {
      if (tenantFilter !== ALL_TENANTS && user.tenantId !== tenantFilter) return false;
      if (!needle) return true;
      return (
        user.displayName.toLowerCase().includes(needle) ||
        user.email.toLowerCase().includes(needle)
      );
    });
  }, [users, tenantFilter, search]);

  async function run(key: string, action: () => Promise<{ ok: boolean; error?: ApiFailure }>) {
    setPending(key);
    setFailure(null);
    const result = await action();
    if (!result.ok && result.error) setFailure(result.error);
    setPending(null);
    router.refresh();
  }

  async function createUser(event: FormEvent) {
    event.preventDefault();
    setPending('create');
    setFailure(null);

    const result = await apiPost('/users', { email, displayName, password });
    if (!result.ok) {
      setFailure(result.error);
      setPending(null);
      return;
    }

    setEmail('');
    setDisplayName('');
    setPassword('');
    setCreating(false);
    setPending(null);
    router.refresh();
  }

  const tooShort = password.length > 0 && password.length < PASSWORD_MIN_LENGTH;
  const columnCount = 6;

  return (
    <div className="space-y-5">
      <FormError>{describeError(failure)}</FormError>

      {canManageUsers && !creating && (
        <Button type="button" onClick={() => setCreating(true)}>
          {t('users.createAction')}
        </Button>
      )}

      {canManageUsers && creating && (
        <Card title={t('users.createTitle')} description={t('users.createBody')}>
          <form onSubmit={createUser} className="space-y-4">
            <Field label={t('setup.name')}>
              {(props) => (
                <TextInput
                  {...props}
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  required
                  minLength={2}
                  autoFocus
                />
              )}
            </Field>

            <Field label={t('auth.email')}>
              {(props) => (
                <TextInput
                  {...props}
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="off"
                />
              )}
            </Field>

            <Field
              label={t('users.initialPassword')}
              hint={t('users.initialPasswordHint', { min: PASSWORD_MIN_LENGTH })}
              error={tooShort ? t('setup.passwordWeak') : undefined}
            >
              {(props) => (
                <TextInput
                  {...props}
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={PASSWORD_MIN_LENGTH}
                  autoComplete="new-password"
                />
              )}
            </Field>

            <div className="flex gap-2">
              <Button type="submit" pending={pending === 'create'} disabled={tooShort}>
                {t('users.createAction')}
              </Button>
              <Button type="button" variant="secondary" onClick={() => setCreating(false)}>
                {t('common.cancel')}
              </Button>
            </div>
          </form>
        </Card>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-ink-muted">
          {t('users.filterTenant')}
          <select
            value={tenantFilter}
            onChange={(event) => setTenantFilter(event.target.value)}
            className="h-8 min-w-48 rounded border border-line bg-surface-2 px-2 text-sm text-ink"
          >
            <option value={ALL_TENANTS}>
              {t('users.filterAllTenants', { count: tenants.length })}
            </option>
            {tenants.map((tenant) => (
              <option key={tenant.id} value={tenant.id}>
                {tenant.isMspRoot ? t('users.mspOrganisation', { name: tenant.name }) : tenant.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-ink-muted">
          {t('users.filterSearch')}
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('users.filterSearchPlaceholder')}
            className="h-8 min-w-56 rounded border border-line bg-surface-2 px-2 text-sm text-ink"
          />
        </label>

        <p className="ml-auto text-xs text-ink-muted">
          {t('users.showingCount', { shown: visible.length, total: users.length })}
        </p>
      </div>

      {/* The scroll container. `max-h` rather than a page-length list: the point
          of a fixed header is that it stays put while the rows move under it. */}
      <div className="max-h-[32rem] overflow-auto rounded border border-line">
        <table className="w-full border-collapse text-left text-sm">
          <thead className="sticky top-0 z-10 bg-surface-2 text-xs text-ink-muted">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                {t('users.columnName')}
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                {t('users.columnTenant')}
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                {t('users.columnRoles')}
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                {t('users.columnMfa')}
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                {t('users.columnLastLogin')}
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                {t('users.columnActions')}
              </th>
            </tr>
          </thead>

          <tbody>
            {visible.length === 0 && (
              <tr>
                <td colSpan={columnCount} className="px-3 py-6 text-center text-sm text-ink-muted">
                  {t('users.noneMatch')}
                </td>
              </tr>
            )}

            {visible.map((user) => {
              const isOpen = expanded === user.id;
              const offerReset = canOfferMfaReset(user, currentUserId, {
                resetMfa: canResetMfa,
                resetMfaMsp: canResetMfaMsp,
              });
              const offerStatus =
                canManageUsers && user.id !== currentUserId && !isLastWayIn(user, users);

              return (
                // The fragment is the list element, so the key belongs on it.
                <Fragment key={user.id}>
                  <tr className="border-t border-line align-top">
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        aria-controls={`user-detail-${user.id}`}
                        onClick={() => setExpanded(isOpen ? null : user.id)}
                        className="text-left"
                      >
                        <span className="font-medium text-ink hover:underline">
                          {user.displayName}
                        </span>
                        {user.id === currentUserId && (
                          <span className="ml-1 text-xs text-ink-muted">{t('users.you')}</span>
                        )}
                        <span className="block text-xs text-ink-muted">{user.email}</span>
                      </button>
                    </td>

                    <td className="px-3 py-2 text-ink-muted">
                      {user.tenantName}
                      {user.tenantIsMspRoot && (
                        <span className="block text-xs">{t('users.mspBadge')}</span>
                      )}
                    </td>

                    <td className="px-3 py-2 text-ink-muted">
                      {user.roles.length === 0 ? (
                        <span className="text-warn">{t('users.noRolesShort')}</span>
                      ) : (
                        user.roles.map((role) => role.name).join(', ')
                      )}
                    </td>

                    <td className="px-3 py-2">
                      {user.mfaEnrolled ? (
                        <StatusBadge tone="ok">{t('mfa.badgeEnrolled')}</StatusBadge>
                      ) : (
                        <StatusBadge tone={user.privileged ? 'warn' : 'neutral'}>
                          {t('mfa.badgeNotEnrolled')}
                        </StatusBadge>
                      )}
                    </td>

                    <td className="px-3 py-2 text-xs text-ink-muted">
                      {user.lastLoginAt
                        ? format.dateTime(new Date(user.lastLoginAt), {
                            dateStyle: 'short',
                            timeStyle: 'short',
                          })
                        : t('users.neverSignedIn')}
                    </td>

                    <td className="px-3 py-2">
                      <div className="flex flex-wrap justify-end gap-1.5">
                        {user.status !== 'ACTIVE' && (
                          <StatusBadge tone="warn">{t('users.statusDisabled')}</StatusBadge>
                        )}

                        {offerReset && (
                          <Button
                            type="button"
                            variant="secondary"
                            pending={pending === `mfa:${user.id}`}
                            disabled={!user.mfaEnrolled}
                            onClick={() =>
                              run(`mfa:${user.id}`, () => apiDelete(`/users/${user.id}/mfa`))
                            }
                          >
                            {t('users.resetMfa')}
                          </Button>
                        )}

                        {offerStatus && (
                          <Button
                            type="button"
                            variant="secondary"
                            pending={pending === `status:${user.id}`}
                            onClick={() =>
                              run(`status:${user.id}`, () =>
                                apiPatch(`/users/${user.id}/status`, {
                                  status: user.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE',
                                }),
                              )
                            }
                          >
                            {user.status === 'ACTIVE' ? t('users.disable') : t('users.enable')}
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>

                  {isOpen && (
                    <tr className="border-t border-line bg-surface-2">
                      <td colSpan={columnCount} className="px-3 py-3" id={`user-detail-${user.id}`}>
                        <div className="space-y-3">
                          {user.status !== 'ACTIVE' && (
                            <Notice tone="warn">{t('users.disabledNotice')}</Notice>
                          )}

                          {/* Said out loud rather than left as a missing button.
                              Someone looking for the control needs to know it is
                              absent on purpose. */}
                          {user.isFoundingAdministrator && (
                            <Notice tone="neutral" title={t('users.foundingTitle')}>
                              {t('users.foundingBody')}
                            </Notice>
                          )}

                          {/* Same reasoning for the reset that is not offered:
                              the rule is stated where the button would be. */}
                          {canResetMfa && !canResetMfaMsp && user.tenantIsMspRoot && (
                            <Notice tone="neutral" title={t('users.resetMfaBlockedTitle')}>
                              {t('users.resetMfaBlockedMsp')}
                            </Notice>
                          )}
                          {canResetMfa && user.id === currentUserId && (
                            <Notice tone="neutral" title={t('users.resetMfaBlockedTitle')}>
                              {t('users.resetMfaBlockedSelf')}
                            </Notice>
                          )}

                          <div>
                            <p className="text-xs text-ink-muted">{t('users.columnRoles')}</p>
                            <ul className="mt-1 flex flex-wrap items-center gap-1.5">
                              {user.roles.length === 0 && (
                                <li className="text-xs text-ink-muted">{t('users.noRoles')}</li>
                              )}
                              {user.roles.map((role) => (
                                <li
                                  key={role.assignmentId}
                                  className="flex items-center gap-1.5 rounded bg-surface px-2 py-0.5 text-xs text-ink"
                                >
                                  {role.name}
                                  {canManageRoles && !user.isFoundingAdministrator && (
                                    <button
                                      type="button"
                                      aria-label={t('users.revokeRole', { role: role.name })}
                                      className="text-ink-muted hover:text-error"
                                      disabled={pending === `revoke:${role.assignmentId}`}
                                      onClick={() =>
                                        run(`revoke:${role.assignmentId}`, () =>
                                          apiDelete(
                                            `/users/${user.id}/role-assignments/${role.assignmentId}`,
                                          ),
                                        )
                                      }
                                    >
                                      ×
                                    </button>
                                  )}
                                </li>
                              ))}
                            </ul>
                          </div>

                          {canManageRoles && (
                            <label className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                              {t('users.grantRole')}
                              <select
                                defaultValue=""
                                disabled={pending === `assign:${user.id}`}
                                onChange={(event) => {
                                  const roleId = event.target.value;
                                  event.target.value = '';
                                  if (!roleId) return;
                                  void run(`assign:${user.id}`, () =>
                                    apiPost(`/users/${user.id}/role-assignments`, { roleId }),
                                  );
                                }}
                                className="h-7 rounded border border-line bg-surface px-1.5 text-xs text-ink"
                              >
                                <option value="">{t('users.chooseRole')}</option>
                                {roles
                                  .filter(
                                    (role) => !user.roles.some((held) => held.roleId === role.id),
                                  )
                                  .map((role) => (
                                    <option key={role.id} value={role.id}>
                                      {role.name}
                                    </option>
                                  ))}
                              </select>
                            </label>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

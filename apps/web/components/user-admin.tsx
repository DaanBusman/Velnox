'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import type { RoleSummary, UserSummary } from '@/lib/session-types';
import { apiDelete, apiPatch, apiPost, type ApiFailure } from '@/lib/client-api';
import { useApiError } from '@/lib/use-api-error';
import { Button, Field, FormError, TextInput } from '@/components/ui/form';
import { Card, Notice } from '@/components/ui/primitives';

const PASSWORD_MIN_LENGTH = 12;

/**
 * Creating an account, and changing what it can do.
 *
 * There is no invitation email, because Velnox sends no email. An administrator
 * sets an initial password and passes it on out of band — which is what actually
 * happens, rather than a flow that pretends a mail server exists.
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
  currentUserId,
}: {
  users: UserSummary[];
  roles: RoleSummary[];
  canManageUsers: boolean;
  canManageRoles: boolean;
  currentUserId: string | null;
}) {
  const t = useTranslations();
  const router = useRouter();
  const describeError = useApiError();

  const [creating, setCreating] = useState(false);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [pending, setPending] = useState<string | null>(null);

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

      {users.map((user) => (
        <Card
          key={user.id}
          title={user.displayName}
          description={user.email}
          actions={
            canManageUsers && user.id !== currentUserId ? (
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
            ) : undefined
          }
        >
          <div className="space-y-3">
            {user.status !== 'ACTIVE' && (
              <Notice tone="warn">{t('users.disabledNotice')}</Notice>
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
                    className="flex items-center gap-1.5 rounded bg-surface-2 px-2 py-0.5 text-xs text-ink"
                  >
                    {role.name}
                    {canManageRoles && (
                      <button
                        type="button"
                        aria-label={t('users.revokeRole', { role: role.name })}
                        className="text-ink-muted hover:text-error"
                        disabled={pending === `revoke:${role.assignmentId}`}
                        onClick={() =>
                          run(`revoke:${role.assignmentId}`, () =>
                            apiDelete(`/users/${user.id}/role-assignments/${role.assignmentId}`),
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
                  className="h-7 rounded border border-line bg-surface-2 px-1.5 text-xs text-ink"
                >
                  <option value="">{t('users.chooseRole')}</option>
                  {roles
                    .filter((role) => !user.roles.some((held) => held.roleId === role.id))
                    .map((role) => (
                      <option key={role.id} value={role.id}>
                        {role.name}
                      </option>
                    ))}
                </select>
              </label>
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}

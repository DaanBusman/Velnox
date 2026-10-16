'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { CUSTOMER_ASSIGNABLE, permissionAreas, type PermissionArea } from '@velnox/shared';
import { apiDelete, apiPost, apiPut, type ApiFailure } from '@/lib/client-api';
import { useApiError } from '@/lib/use-api-error';
import type { RoleSummary } from '@/lib/session-types';
import { Button, Field, FormError, TextInput } from '@/components/ui/form';
import { Card, Notice, StatusBadge } from '@/components/ui/primitives';

type Level = 'none' | 'read' | 'change';

/** `users.reset_mfa` → `users_reset_mfa`, the key its label is under. */
const labelKey = (permission: string) => permission.replace('.', '_');

/**
 * Custom roles (ADR-054): made by the MSP, as the owner asked, with each area
 * of the catalogue set to None, Can only read or Can change.
 *
 * "Can change" ticks every change permission of the area, and each can be
 * unticked — updates has running them and setting their policy, jobs has
 * cancelling and approving, which are different levels of trust. What this
 * account does not hold, or what a role customers may be given cannot hold,
 * is shown and cannot be chosen; the API decides again, and refuses the same.
 */
export function CustomRoles({
  roles,
  canManage,
  held,
}: {
  roles: RoleSummary[];
  canManage: boolean;
  /** What the person making the role holds — the most a role they make can hold. */
  held: string[];
}) {
  const t = useTranslations();
  const router = useRouter();
  const describeError = useApiError();
  const [editing, setEditing] = useState<RoleSummary | 'new' | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);

  async function remove(role: RoleSummary) {
    setFailure(null);
    const result = await apiDelete(`/roles/${role.id}`);
    setRemoving(null);
    if (!result.ok) return setFailure(result.error);
    router.refresh();
  }

  return (
    <Card
      title={t('roles.customTitle')}
      description={t('roles.customBody')}
      actions={
        canManage ? (
          <Button variant="secondary" onClick={() => setEditing('new')}>
            {t('roles.newRole')}
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-3">
        {failure && <FormError>{describeError(failure)}</FormError>}
        {roles.length === 0 && <p className="text-sm text-ink-muted">{t('roles.customNone')}</p>}
        {roles.map((role) => (
          <div key={role.id} className="rounded border border-line px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-ink">{role.name}</span>
              <StatusBadge tone="neutral">{t('roles.custom')}</StatusBadge>
              {role.mspOnly && <StatusBadge tone="neutral">{t('roles.mspOnly')}</StatusBadge>}
              <StatusBadge tone={role.assignmentCount > 0 ? 'ok' : 'neutral'}>
                {t('roles.assigned', { count: role.assignmentCount })}
              </StatusBadge>
              {canManage && (
                <span className="ml-auto flex gap-1">
                  <Button variant="quiet" onClick={() => setEditing(role)}>
                    {t('roles.editRole')}
                  </Button>
                  {removing === role.id ? (
                    <>
                      <Button variant="secondary" onClick={() => void remove(role)}>
                        {t('roles.removeConfirm')}
                      </Button>
                      <Button variant="quiet" onClick={() => setRemoving(null)}>
                        {t('common.cancel')}
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="quiet"
                      disabled={role.assignmentCount > 0}
                      title={
                        role.assignmentCount > 0
                          ? t('roles.removeHeld', { count: role.assignmentCount })
                          : undefined
                      }
                      onClick={() => setRemoving(role.id)}
                    >
                      {t('roles.remove')}
                    </Button>
                  )}
                </span>
              )}
            </div>
            {role.description && <p className="mt-1 text-xs text-ink-muted">{role.description}</p>}
            <AreaSummary permissions={role.permissions} />
          </div>
        ))}
      </div>

      {editing && (
        <RoleEditor
          role={editing === 'new' ? null : editing}
          held={held}
          onClose={(saved) => {
            setEditing(null);
            if (saved) router.refresh();
          }}
        />
      )}
    </Card>
  );
}

/** Each area the role touches, and whether it reads or changes there. */
function AreaSummary({ permissions }: { permissions: string[] }) {
  const t = useTranslations();
  const areas = permissionAreas()
    .map((area) => ({ area, level: levelOf(area, new Set(permissions)) }))
    .filter((entry) => entry.level !== 'none');
  return (
    <ul className="mt-2 flex flex-wrap gap-1.5">
      {areas.map(({ area, level }) => (
        <li key={area.key} className="rounded bg-surface-2 px-2 py-0.5 text-xs text-ink">
          {t(`roles.areas.${area.key}`)} ·{' '}
          <span className="text-ink-muted">
            {level === 'change' ? t('roles.levelChange') : t('roles.levelRead')}
          </span>
        </li>
      ))}
    </ul>
  );
}

function levelOf(area: PermissionArea, chosen: ReadonlySet<string>): Level {
  if (area.changes.some((p) => chosen.has(p))) return 'change';
  if (area.read && chosen.has(area.read)) return 'read';
  return 'none';
}

function RoleEditor({
  role,
  held,
  onClose,
}: {
  role: RoleSummary | null;
  held: string[];
  onClose: (saved: boolean) => void;
}) {
  const t = useTranslations();
  const describeError = useApiError();
  const ref = useRef<HTMLDialogElement>(null);
  const areas = useMemo(() => permissionAreas(), []);
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [mspOnly, setMspOnly] = useState(role?.mspOnly ?? true);
  const [chosen, setChosen] = useState<Set<string>>(new Set(role?.permissions ?? []));
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  const heldSet = useMemo(() => new Set(held), [held]);
  const customerSet = useMemo(() => new Set<string>(CUSTOMER_ASSIGNABLE), []);
  const allowed = (permission: string) =>
    heldSet.has(permission) && (mspOnly || customerSet.has(permission));

  // A role customers may be given loses what a customer may never hold.
  const chooseAudience = (onlyMsp: boolean) => {
    setMspOnly(onlyMsp);
    if (!onlyMsp) setChosen((now) => new Set([...now].filter((p) => customerSet.has(p))));
  };

  const setLevel = (area: PermissionArea, level: Level) => {
    setChosen((now) => {
      const next = new Set(now);
      for (const p of [...(area.read ? [area.read] : []), ...area.changes]) next.delete(p);
      if (level !== 'none' && area.read && allowed(area.read)) next.add(area.read);
      if (level === 'change') for (const p of area.changes) if (allowed(p)) next.add(p);
      return next;
    });
  };

  const toggle = (permission: string, on: boolean) =>
    setChosen((now) => {
      const next = new Set(now);
      if (on) next.add(permission);
      else next.delete(permission);
      return next;
    });

  async function save() {
    setPending(true);
    setFailure(null);
    const body = {
      name: name.trim(),
      description: description.trim() || null,
      mspOnly,
      permissions: [...chosen],
    };
    const result = role ? await apiPut(`/roles/${role.id}`, body) : await apiPost('/roles', body);
    setPending(false);
    if (!result.ok) return setFailure(result.error);
    ref.current?.close();
    onClose(true);
  }

  const level = (area: PermissionArea) => levelOf(area, chosen);

  return (
    <dialog
      ref={ref}
      aria-labelledby="role-editor-title"
      onClose={() => onClose(false)}
      className="w-[min(52rem,calc(100vw-2rem))] max-h-[calc(100dvh-4rem)] overflow-y-auto rounded-lg border border-line bg-surface p-0 text-ink shadow-2xl backdrop:bg-black/50 backdrop:backdrop-blur-[2px]"
    >
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <h2 id="role-editor-title" className="text-sm font-semibold tracking-tight">
          {role ? t('roles.editRole') : t('roles.newRole')}
        </h2>
        <button
          type="button"
          onClick={() => ref.current?.close()}
          aria-label={t('common.close')}
          className="grid size-7 place-items-center rounded text-ink-muted hover:bg-surface-2 hover:text-ink"
        >
          <span aria-hidden>×</span>
        </button>
      </div>

      <div className="space-y-4 p-5">
        {failure && <FormError>{describeError(failure)}</FormError>}
        <Field label={t('roles.name')}>
          {(props) => (
            <TextInput
              {...props}
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <Field label={t('roles.description')}>
          {(props) => (
            <TextInput
              {...props}
              value={description}
              maxLength={300}
              onChange={(e) => setDescription(e.target.value)}
            />
          )}
        </Field>

        <fieldset className="space-y-1 text-sm">
          <legend className="mb-1 text-xs font-medium text-ink">{t('roles.assignableTo')}</legend>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="audience"
              checked={mspOnly}
              onChange={() => chooseAudience(true)}
            />
            {t('roles.assignableMsp')}
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="audience"
              checked={!mspOnly}
              onChange={() => chooseAudience(false)}
            />
            {t('roles.assignableAll')}
          </label>
          {!mspOnly && <p className="text-xs text-ink-muted">{t('roles.assignableAllHint')}</p>}
        </fieldset>

        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-ink-muted">
              <th className="py-1.5 pr-2 font-medium">{t('roles.area')}</th>
              <th className="px-2 font-medium">{t('roles.levelNone')}</th>
              <th className="px-2 font-medium">{t('roles.levelRead')}</th>
              <th className="px-2 font-medium">{t('roles.levelChange')}</th>
            </tr>
          </thead>
          <tbody>
            {areas.map((area) => {
              const readable = !area.read || allowed(area.read);
              const changeable = readable && area.changes.some(allowed);
              const current = level(area);
              const radio = (value: Level, enabled: boolean) => (
                <td className="px-2 py-1.5">
                  <input
                    type="radio"
                    name={`level-${area.key}`}
                    aria-label={`${t(`roles.areas.${area.key}`)}: ${t(
                      value === 'none'
                        ? 'roles.levelNone'
                        : value === 'read'
                          ? 'roles.levelRead'
                          : 'roles.levelChange',
                    )}`}
                    checked={current === value}
                    disabled={!enabled}
                    onChange={() => setLevel(area, value)}
                  />
                </td>
              );
              return (
                <tr key={area.key} className="border-b border-line/60 align-top">
                  <td className="py-1.5 pr-2">
                    <span className="text-ink">{t(`roles.areas.${area.key}`)}</span>
                    {current === 'change' && area.changes.length > 0 && (
                      <ul className="mt-1 space-y-0.5">
                        {area.changes.map((permission) => (
                          <li key={permission}>
                            <label
                              className={`flex items-center gap-1.5 text-xs ${allowed(permission) ? 'text-ink-muted' : 'text-ink-muted/50'}`}
                            >
                              <input
                                type="checkbox"
                                checked={chosen.has(permission)}
                                disabled={!allowed(permission)}
                                onChange={(e) => toggle(permission, e.target.checked)}
                              />
                              {t(`roles.perm.${labelKey(permission)}`)}
                              {!allowed(permission) && ` — ${t('roles.notAvailable')}`}
                            </label>
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  {radio('none', true)}
                  {radio('read', Boolean(area.read) && readable)}
                  {radio('change', changeable)}
                </tr>
              );
            })}
          </tbody>
        </table>

        {chosen.size === 0 && <Notice>{t('roles.noPermissions')}</Notice>}

        <div className="flex gap-2 border-t border-line pt-4">
          <Button pending={pending} disabled={!name.trim()} onClick={() => void save()}>
            {t('roles.save')}
          </Button>
          <Button variant="secondary" onClick={() => ref.current?.close()}>
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    </dialog>
  );
}

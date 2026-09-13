'use client';

import { useRouter } from 'next/navigation';
import { Fragment, useMemo, useState, type FormEvent } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import type { TenantSummary } from '@/lib/session-types';
import { apiDelete, apiPatch, apiPost, type ApiFailure } from '@/lib/client-api';
import { useApiError } from '@/lib/use-api-error';
import { Button, Field, FormError, TextInput } from '@/components/ui/form';
import { Card, Notice, StatusBadge, type StatusTone } from '@/components/ui/primitives';

type MfaPolicy = TenantSummary['mfaPolicy'];

const MFA_POLICIES: MfaPolicy[] = ['OPTIONAL', 'REQUIRED_FOR_PRIVILEGED', 'REQUIRED'];

const STATUS_TONE: Record<TenantSummary['status'], StatusTone> = {
  ACTIVE: 'ok',
  SUSPENDED: 'warn',
  ARCHIVED: 'unknown',
};

/**
 * Tenants, as a table.
 *
 * The same shape as the accounts list, for the same reason: a column per
 * question, so "who is suspended" and "who has no sites yet" are answered by
 * scanning one column rather than by reading every card in full.
 *
 * Everything offered here is enforced again by the API. What this decides is
 * whether someone is shown a control they cannot use — including the two
 * refusals that are properties of a row rather than of a permission: the MSP
 * organisation cannot be suspended or archived, and neither can your own tenant.
 */
export function TenantAdmin({
  tenants,
  canManage,
  currentTenantId,
}: {
  tenants: TenantSummary[];
  canManage: boolean;
  /** The tenant the viewer's own account lives in. Archiving it is refused. */
  currentTenantId: string | null;
}) {
  const t = useTranslations();
  const format = useFormatter();
  const router = useRouter();
  const describeError = useApiError();

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return tenants;
    return tenants.filter(
      (tenant) =>
        tenant.name.toLowerCase().includes(needle) || tenant.slug.includes(needle),
    );
  }, [tenants, search]);

  async function run(key: string, action: () => Promise<{ ok: boolean; error?: ApiFailure }>) {
    setPending(key);
    setFailure(null);
    const result = await action();
    setPending(null);

    if (!result.ok) {
      setFailure(result.error ?? { code: 'generic', status: 0 });
      return false;
    }

    router.refresh();
    return true;
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    const ok = await run('create', () => apiPost('/tenants', { name }));
    if (ok) {
      setName('');
      setCreating(false);
    }
  }

  return (
    <div className="space-y-4">
      {failure && <FormError>{describeError(failure)}</FormError>}

      <Card
        title={t('tenants.title')}
        description={t('tenants.subtitle')}
        actions={
          canManage && (
            <Button variant={creating ? 'secondary' : 'primary'} onClick={() => setCreating(!creating)}>
              {creating ? t('common.cancel') : t('tenants.add')}
            </Button>
          )
        }
        bodyClassName=""
      >
        {creating && (
          <form onSubmit={create} className="space-y-3 border-b border-line bg-surface-2/50 px-4 py-4">
            <Field label={t('tenants.name')} hint={t('tenants.slugDerived')}>
              {(props) => (
                <TextInput
                  {...props}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                  minLength={2}
                  maxLength={120}
                  autoFocus
                />
              )}
            </Field>
            <Button type="submit" pending={pending === 'create'}>
              {t('tenants.add')}
            </Button>
          </form>
        )}

        <div className="border-b border-line px-4 py-2.5">
          <label className="flex items-center gap-2">
            <span className="sr-only">{t('common.search')}</span>
            <TextInput
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('tenants.searchPlaceholder')}
              className="h-8 max-w-xs text-xs"
            />
          </label>
        </div>

        {visible.length === 0 ? (
          <p className="px-4 py-6 text-sm text-ink-muted">{t('tenants.none')}</p>
        ) : (
          /* The table scrolls under its own sticky header rather than moving the
             page: at fifty customers the column meanings have to stay visible. */
          <div className="max-h-[60vh] overflow-auto">
            <table className="w-full border-collapse text-sm">
              <thead className="sticky top-0 z-10 bg-surface-2 text-left text-xs text-ink-muted shadow-[0_1px_0_var(--velnox-border)]">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">
                    {t('tenants.name')}
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    {t('tenants.status')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    {t('nav.users')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    {t('nav.sites')}
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    {t('tenants.mfaPolicy')}
                  </th>
                  <th scope="col" className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {visible.map((tenant) => {
                  const isOpen = expanded === tenant.id;
                  const isMsp = tenant.kind === 'MSP_ROOT';
                  const isOwn = tenant.id === currentTenantId;

                  return (
                    <Fragment key={tenant.id}>
                      <tr className="border-b border-line/70 align-middle hover:bg-surface-2/50">
                        <td className="px-4 py-2.5">
                          <span className="font-medium text-ink">{tenant.name}</span>
                          {isMsp && (
                            <span className="ml-2 rounded border border-line bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-ink-muted">
                              {t('tenants.mspOrganisation')}
                            </span>
                          )}
                          <span className="block font-mono text-[11px] text-ink-muted">
                            {tenant.slug}
                          </span>
                        </td>
                        <td className="px-3 py-2.5">
                          <StatusBadge tone={STATUS_TONE[tenant.status]}>
                            {t(`tenants.status${tenant.status}`)}
                          </StatusBadge>
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-ink-muted">
                          {tenant.userCount}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-ink-muted">
                          {tenant.siteCount}
                        </td>
                        <td className="px-3 py-2.5 text-xs text-ink-muted">
                          {t(`tenants.mfa${tenant.mfaPolicy}`)}
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <Button
                            variant="quiet"
                            className="h-7 px-2 text-xs"
                            aria-expanded={isOpen}
                            onClick={() => setExpanded(isOpen ? null : tenant.id)}
                          >
                            {isOpen ? t('common.close') : t('tenants.details')}
                          </Button>
                        </td>
                      </tr>

                      {isOpen && (
                        <tr className="border-b border-line bg-surface-2/40">
                          <td colSpan={6} className="px-4 py-3.5">
                            <dl className="mb-3 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
                              <div className="flex gap-2">
                                <dt className="text-ink-muted">{t('tenants.created')}</dt>
                                <dd className="text-ink">
                                  {format.dateTime(new Date(tenant.createdAt), 'medium')}
                                </dd>
                              </div>
                              <div className="flex gap-2">
                                <dt className="text-ink-muted">{t('tenants.identifier')}</dt>
                                <dd className="font-mono text-ink">{tenant.id}</dd>
                              </div>
                            </dl>

                            {canManage ? (
                              <TenantControls
                                tenant={tenant}
                                isMsp={isMsp}
                                isOwn={isOwn}
                                pending={pending}
                                onRename={(value) =>
                                  run(`rename:${tenant.id}`, () =>
                                    apiPatch(`/tenants/${tenant.id}`, { name: value }),
                                  )
                                }
                                onPolicy={(value) =>
                                  run(`policy:${tenant.id}`, () =>
                                    apiPatch(`/tenants/${tenant.id}`, { mfaPolicy: value }),
                                  )
                                }
                                onStatus={(value) =>
                                  run(`status:${tenant.id}`, () =>
                                    apiPatch(`/tenants/${tenant.id}`, { status: value }),
                                  )
                                }
                                onArchive={() =>
                                  run(`archive:${tenant.id}`, () =>
                                    apiDelete(`/tenants/${tenant.id}`),
                                  )
                                }
                              />
                            ) : (
                              <p className="text-xs text-ink-muted">
                                {t('common.requiresPermission', { permission: 'tenants.manage' })}
                              </p>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

/**
 * The controls for one tenant.
 *
 * The two that can be refused say why they are absent rather than simply not
 * being there. "The button is missing" is a bug report; "the MSP organisation
 * cannot be archived" is an answer.
 */
function TenantControls({
  tenant,
  isMsp,
  isOwn,
  pending,
  onRename,
  onPolicy,
  onStatus,
  onArchive,
}: {
  tenant: TenantSummary;
  isMsp: boolean;
  isOwn: boolean;
  pending: string | null;
  onRename: (value: string) => Promise<boolean>;
  onPolicy: (value: MfaPolicy) => Promise<boolean>;
  onStatus: (value: 'ACTIVE' | 'SUSPENDED') => Promise<boolean>;
  onArchive: () => Promise<boolean>;
}) {
  const t = useTranslations();
  const [name, setName] = useState(tenant.name);
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="space-y-3">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={async (event) => {
          event.preventDefault();
          await onRename(name);
        }}
      >
        <Field label={t('tenants.name')}>
          {(props) => (
            <TextInput
              {...props}
              value={name}
              onChange={(event) => setName(event.target.value)}
              minLength={2}
              maxLength={120}
              className="h-8 w-56 text-xs"
            />
          )}
        </Field>
        <Button
          type="submit"
          variant="secondary"
          className="h-8 text-xs"
          disabled={name.trim() === tenant.name}
          pending={pending === `rename:${tenant.id}`}
        >
          {t('common.save')}
        </Button>
      </form>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-xs text-ink-muted">
          {t('tenants.mfaPolicy')}
          <select
            value={tenant.mfaPolicy}
            disabled={pending === `policy:${tenant.id}`}
            onChange={(event) => void onPolicy(event.target.value as MfaPolicy)}
            className="h-8 rounded border border-line bg-surface px-2 text-xs text-ink"
          >
            {MFA_POLICIES.map((policy) => (
              <option key={policy} value={policy}>
                {t(`tenants.mfa${policy}`)}
              </option>
            ))}
          </select>
        </label>

        {!isMsp && (
          <Button
            variant="secondary"
            className="h-8 text-xs"
            pending={pending === `status:${tenant.id}`}
            onClick={() => void onStatus(tenant.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE')}
          >
            {tenant.status === 'ACTIVE' ? t('tenants.suspend') : t('tenants.resume')}
          </Button>
        )}
      </div>

      {isMsp ? (
        <Notice tone="neutral">{t('tenants.mspCannotBeArchived')}</Notice>
      ) : isOwn ? (
        <Notice tone="neutral">{t('tenants.ownCannotBeArchived')}</Notice>
      ) : confirming ? (
        <Notice tone="warn" title={t('tenants.archiveTitle')}>
          <p>{t('tenants.archiveExplanation')}</p>
          <div className="mt-2 flex gap-2">
            <Button
              variant="secondary"
              className="h-8 text-xs"
              pending={pending === `archive:${tenant.id}`}
              onClick={() => void onArchive()}
            >
              {t('tenants.archiveConfirm')}
            </Button>
            <Button variant="quiet" className="h-8 text-xs" onClick={() => setConfirming(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        </Notice>
      ) : (
        <Button variant="quiet" className="h-8 px-2 text-xs" onClick={() => setConfirming(true)}>
          {t('tenants.archive')}
        </Button>
      )}
    </div>
  );
}

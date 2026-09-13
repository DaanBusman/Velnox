'use client';

import { useRouter } from 'next/navigation';
import { Fragment, useMemo, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import type { SiteSummary, TenantSummary } from '@/lib/session-types';
import { apiDelete, apiPatch, apiPost, type ApiFailure } from '@/lib/client-api';
import { useApiError } from '@/lib/use-api-error';
import { Button, Field, FormError, TextInput } from '@/components/ui/form';
import { Card, Notice } from '@/components/ui/primitives';

interface Draft {
  tenantId: string;
  name: string;
  locality: string;
  country: string;
  timezone: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
}

const emptyDraft = (tenantId: string): Draft => ({
  tenantId,
  name: '',
  locality: '',
  country: '',
  timezone: '',
  contactName: '',
  contactEmail: '',
  contactPhone: '',
});

/** Empty strings mean "not given", which the API expects as null rather than "". */
const nullable = (value: string): string | null => (value.trim() === '' ? null : value.trim());

/**
 * Sites.
 *
 * A site belongs to exactly one tenant and the tenant cannot be changed
 * afterwards — moving one would move every grant scoped to it, silently. So the
 * tenant is a field on the creation form and nowhere else, and the table groups
 * by it when more than one is in view.
 */
export function SiteAdmin({
  sites,
  tenants,
  canManage,
  defaultTenantId,
}: {
  sites: SiteSummary[];
  /** Tenants the viewer can create a site in. Empty hides the creation form. */
  tenants: TenantSummary[];
  canManage: boolean;
  defaultTenantId: string | null;
}) {
  const t = useTranslations();
  const router = useRouter();
  const describeError = useApiError();

  const firstTenant = defaultTenantId ?? tenants[0]?.id ?? '';

  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(firstTenant));
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return sites;
    return sites.filter(
      (site) =>
        site.name.toLowerCase().includes(needle) ||
        (site.locality ?? '').toLowerCase().includes(needle) ||
        site.tenantName.toLowerCase().includes(needle),
    );
  }, [sites, search]);

  // Only worth a column when more than one tenant is on screen. With the
  // selector set to one customer it would be the same value on every row.
  const showTenantColumn = useMemo(
    () => new Set(sites.map((site) => site.tenantId)).size > 1,
    [sites],
  );

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
    const ok = await run('create', () =>
      apiPost('/sites', {
        tenantId: draft.tenantId,
        name: draft.name,
        locality: nullable(draft.locality),
        country: nullable(draft.country),
        timezone: nullable(draft.timezone),
        contactName: nullable(draft.contactName),
        contactEmail: nullable(draft.contactEmail),
        contactPhone: nullable(draft.contactPhone),
      }),
    );

    if (ok) {
      setDraft(emptyDraft(draft.tenantId));
      setCreating(false);
    }
  }

  const canCreate = canManage && tenants.length > 0;

  return (
    <div className="space-y-4">
      {failure && <FormError>{describeError(failure)}</FormError>}

      <Card
        title={t('sites.title')}
        description={t('sites.subtitle')}
        actions={
          canCreate && (
            <Button
              variant={creating ? 'secondary' : 'primary'}
              onClick={() => setCreating(!creating)}
            >
              {creating ? t('common.cancel') : t('sites.add')}
            </Button>
          )
        }
        bodyClassName=""
      >
        {creating && (
          <form
            onSubmit={create}
            className="grid gap-3 border-b border-line bg-surface-2/50 px-4 py-4 sm:grid-cols-2"
          >
            <Field label={t('sites.tenant')} hint={t('sites.tenantIsFixed')}>
              {(props) => (
                <select
                  {...props}
                  value={draft.tenantId}
                  onChange={(event) => setDraft({ ...draft, tenantId: event.target.value })}
                  className="h-9 w-full rounded border border-line bg-surface px-2.5 text-sm text-ink"
                >
                  {tenants.map((tenant) => (
                    <option key={tenant.id} value={tenant.id}>
                      {tenant.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>

            <Field label={t('sites.name')} hint={t('sites.slugDerived')}>
              {(props) => (
                <TextInput
                  {...props}
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  required
                  minLength={2}
                  maxLength={120}
                />
              )}
            </Field>

            <Field label={t('sites.locality')}>
              {(props) => (
                <TextInput
                  {...props}
                  value={draft.locality}
                  onChange={(event) => setDraft({ ...draft, locality: event.target.value })}
                  maxLength={120}
                />
              )}
            </Field>

            <Field label={t('sites.country')} hint={t('sites.countryHint')}>
              {(props) => (
                <TextInput
                  {...props}
                  value={draft.country}
                  onChange={(event) => setDraft({ ...draft, country: event.target.value })}
                  maxLength={2}
                  className="w-24 uppercase"
                />
              )}
            </Field>

            <Field label={t('sites.contactName')}>
              {(props) => (
                <TextInput
                  {...props}
                  value={draft.contactName}
                  onChange={(event) => setDraft({ ...draft, contactName: event.target.value })}
                  maxLength={120}
                />
              )}
            </Field>

            <Field label={t('sites.contactPhone')} hint={t('sites.contactHint')}>
              {(props) => (
                <TextInput
                  {...props}
                  value={draft.contactPhone}
                  onChange={(event) => setDraft({ ...draft, contactPhone: event.target.value })}
                  maxLength={40}
                />
              )}
            </Field>

            <div className="sm:col-span-2">
              <Button type="submit" pending={pending === 'create'}>
                {t('sites.add')}
              </Button>
            </div>
          </form>
        )}

        <div className="border-b border-line px-4 py-2.5">
          <label className="flex items-center gap-2">
            <span className="sr-only">{t('common.search')}</span>
            <TextInput
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('sites.searchPlaceholder')}
              className="h-8 max-w-xs text-xs"
            />
          </label>
        </div>

        {visible.length === 0 ? (
          <p className="px-4 py-6 text-sm text-ink-muted">{t('sites.none')}</p>
        ) : (
          <div className="max-h-[60vh] overflow-auto">
            <table className="w-full border-collapse text-sm">
              <thead className="sticky top-0 z-10 bg-surface-2 text-left text-xs text-ink-muted shadow-[0_1px_0_var(--velnox-border)]">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">
                    {t('sites.name')}
                  </th>
                  {showTenantColumn && (
                    <th scope="col" className="px-3 py-2 font-medium">
                      {t('sites.tenant')}
                    </th>
                  )}
                  <th scope="col" className="px-3 py-2 font-medium">
                    {t('sites.locality')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    {t('sites.grants')}
                  </th>
                  <th scope="col" className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {visible.map((site) => {
                  const isOpen = expanded === site.id;

                  return (
                    <Fragment key={site.id}>
                      <tr className="border-b border-line/70 align-middle hover:bg-surface-2/50">
                        <td className="px-4 py-2.5">
                          <span className="font-medium text-ink">{site.name}</span>
                          <span className="block font-mono text-[11px] text-ink-muted">
                            {site.slug}
                          </span>
                        </td>
                        {showTenantColumn && (
                          <td className="px-3 py-2.5 text-ink-muted">{site.tenantName}</td>
                        )}
                        <td className="px-3 py-2.5 text-ink-muted">
                          {[site.locality, site.country].filter(Boolean).join(', ') || '—'}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-ink-muted">
                          {site.grantCount}
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <Button
                            variant="quiet"
                            className="h-7 px-2 text-xs"
                            aria-expanded={isOpen}
                            onClick={() => setExpanded(isOpen ? null : site.id)}
                          >
                            {isOpen ? t('common.close') : t('sites.details')}
                          </Button>
                        </td>
                      </tr>

                      {isOpen && (
                        <tr className="border-b border-line bg-surface-2/40">
                          <td colSpan={showTenantColumn ? 5 : 4} className="px-4 py-3.5">
                            <SiteControls
                              site={site}
                              canManage={canManage}
                              pending={pending}
                              onSave={(patch) =>
                                run(`save:${site.id}`, () => apiPatch(`/sites/${site.id}`, patch))
                              }
                              onRemove={() =>
                                run(`remove:${site.id}`, () => apiDelete(`/sites/${site.id}`))
                              }
                            />
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

function SiteControls({
  site,
  canManage,
  pending,
  onSave,
  onRemove,
}: {
  site: SiteSummary;
  canManage: boolean;
  pending: string | null;
  onSave: (patch: Record<string, string | null>) => Promise<boolean>;
  onRemove: () => Promise<boolean>;
}) {
  const t = useTranslations();
  const [name, setName] = useState(site.name);
  const [locality, setLocality] = useState(site.locality ?? '');
  const [contactName, setContactName] = useState(site.contactName ?? '');
  const [contactEmail, setContactEmail] = useState(site.contactEmail ?? '');
  const [contactPhone, setContactPhone] = useState(site.contactPhone ?? '');
  const [confirming, setConfirming] = useState(false);

  if (!canManage) {
    return (
      <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
        <Detail label={t('sites.contactName')} value={site.contactName} />
        <Detail label={t('sites.contactEmail')} value={site.contactEmail} />
        <Detail label={t('sites.contactPhone')} value={site.contactPhone} />
        <Detail label={t('sites.identifier')} value={site.id} mono />
      </dl>
    );
  }

  return (
    <div className="space-y-3">
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={async (event) => {
          event.preventDefault();
          await onSave({
            name,
            locality: locality.trim() || null,
            contactName: contactName.trim() || null,
            contactEmail: contactEmail.trim() || null,
            contactPhone: contactPhone.trim() || null,
          });
        }}
      >
        <Field label={t('sites.name')}>
          {(props) => (
            <TextInput
              {...props}
              value={name}
              onChange={(event) => setName(event.target.value)}
              minLength={2}
              maxLength={120}
              className="h-8 text-xs"
            />
          )}
        </Field>
        <Field label={t('sites.locality')}>
          {(props) => (
            <TextInput
              {...props}
              value={locality}
              onChange={(event) => setLocality(event.target.value)}
              maxLength={120}
              className="h-8 text-xs"
            />
          )}
        </Field>
        <Field label={t('sites.contactName')}>
          {(props) => (
            <TextInput
              {...props}
              value={contactName}
              onChange={(event) => setContactName(event.target.value)}
              maxLength={120}
              className="h-8 text-xs"
            />
          )}
        </Field>
        <Field label={t('sites.contactEmail')}>
          {(props) => (
            <TextInput
              {...props}
              type="email"
              value={contactEmail}
              onChange={(event) => setContactEmail(event.target.value)}
              maxLength={320}
              className="h-8 text-xs"
            />
          )}
        </Field>
        <Field label={t('sites.contactPhone')}>
          {(props) => (
            <TextInput
              {...props}
              value={contactPhone}
              onChange={(event) => setContactPhone(event.target.value)}
              maxLength={40}
              className="h-8 text-xs"
            />
          )}
        </Field>

        <div className="flex items-end">
          <Button
            type="submit"
            variant="secondary"
            className="h-8 text-xs"
            pending={pending === `save:${site.id}`}
          >
            {t('common.save')}
          </Button>
        </div>
      </form>

      {site.grantCount > 0 ? (
        // The API refuses this, and saying why beforehand is better than offering
        // a button whose only outcome is an explanation.
        <Notice tone="neutral">{t('sites.hasGrants', { count: site.grantCount })}</Notice>
      ) : confirming ? (
        <Notice tone="warn" title={t('sites.removeTitle')}>
          <p>{t('sites.removeExplanation')}</p>
          <div className="mt-2 flex gap-2">
            <Button
              variant="secondary"
              className="h-8 text-xs"
              pending={pending === `remove:${site.id}`}
              onClick={() => void onRemove()}
            >
              {t('sites.removeConfirm')}
            </Button>
            <Button variant="quiet" className="h-8 text-xs" onClick={() => setConfirming(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        </Notice>
      ) : (
        <Button variant="quiet" className="h-8 px-2 text-xs" onClick={() => setConfirming(true)}>
          {t('sites.remove')}
        </Button>
      )}
    </div>
  );
}

function Detail({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="text-ink-muted">{label}</dt>
      <dd className={mono ? 'font-mono text-ink' : 'text-ink'}>{value ?? '—'}</dd>
    </div>
  );
}

'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import clsx from 'clsx';
import { setSelectedTenant } from '@/app/actions';

export interface SelectableTenant {
  id: string;
  name: string;
  kind: 'MSP_ROOT' | 'CUSTOMER';
}

/**
 * The tenant filter in the top bar.
 *
 * It narrows what the pages below show. It does not grant anything and cannot
 * take anything away: the API scopes every list to the caller's own grants, so
 * this only ever chooses a subset of what they could already see. Which is why
 * it can be a cookie rather than something the server has to defend.
 *
 * Absent entirely for an account that reaches exactly one tenant. A selector
 * with one option is a control that looks like a choice and is not one — and for
 * a customer's own administrator, "which customer" is not a question.
 */
export function TenantSelector({
  tenants,
  selected,
}: {
  tenants: SelectableTenant[];
  selected: string | null;
}) {
  const t = useTranslations();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  if (tenants.length < 2) return null;

  return (
    <label className="flex h-8 shrink-0 items-center gap-2 rounded border border-line bg-surface px-2 shadow-card velnox-lit">
      <span className="text-[11px] font-medium text-ink-muted">{t('layout.tenantSelector')}</span>
      <select
        value={selected ?? ''}
        disabled={pending}
        aria-busy={pending || undefined}
        onChange={(event) => {
          const value = event.target.value;
          startTransition(async () => {
            await setSelectedTenant(value);
            // The pages read the cookie on the server, so the new selection only
            // takes effect once they are asked again.
            router.refresh();
          });
        }}
        className={clsx(
          'max-w-[14rem] truncate bg-transparent py-0.5 text-xs font-medium text-ink',
          'focus:outline-none disabled:cursor-progress disabled:opacity-60',
        )}
      >
        <option value="">{t('tenants.allTenants')}</option>
        {tenants.map((tenant) => (
          <option key={tenant.id} value={tenant.id}>
            {tenant.kind === 'MSP_ROOT' ? `${tenant.name} · ${t('tenants.mspOrganisation')}` : tenant.name}
          </option>
        ))}
      </select>
    </label>
  );
}

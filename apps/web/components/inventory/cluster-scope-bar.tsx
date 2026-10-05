'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

/**
 * The cluster a per-cluster page shows, chosen from the selected tenant's.
 * Kept in the address, so a link to one cluster's networks stays one.
 */
export function ClusterPicker({
  tenantName,
  clusters,
  selected,
}: {
  tenantName: string;
  clusters: { id: string; name: string }[];
  selected: string;
}) {
  const t = useTranslations();
  const router = useRouter();
  const pathname = usePathname();

  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
      <span className="text-ink-muted">{t('inventory.scopeTenant', { tenant: tenantName })}</span>
      <label className="flex items-center gap-2">
        <span className="text-ink-muted">{t('inventory.scopeCluster')}</span>
        <select
          value={selected}
          onChange={(event) => router.push(`${pathname}?cluster=${event.target.value}`)}
          className="h-8 rounded border border-line bg-surface px-2 text-sm text-ink focus:border-accent focus:outline-none"
        >
          {clusters.map((cluster) => (
            <option key={cluster.id} value={cluster.id}>
              {cluster.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

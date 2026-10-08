'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { PACKAGE_MAX_BYTES, type PackageSummary } from '@velnox/shared';
import { apiDelete, type ApiFailure } from '@/lib/client-api';
import { useApiError } from '@/lib/use-api-error';
import type { TenantSummary } from '@/lib/session-types';
import { Button, Field, FormError } from '@/components/ui/form';
import { Card, Notice, StatusBadge, type StatusTone } from '@/components/ui/primitives';
import { formatBytes } from '@/components/inventory/primitives';
import { useApiResource } from '@/components/server/use-api-resource';
import { useUploads } from '@/components/library/uploads-provider';

const select =
  'block h-9 w-full rounded border border-line bg-surface-2 px-2.5 text-sm text-ink focus:border-accent focus:outline-none';

const TONE: Record<PackageSummary['state'], StatusTone> = {
  RECEIVING: 'neutral',
  VERIFYING: 'neutral',
  READY: 'ok',
  FAILED: 'error',
};

/**
 * A tenant's installer packages (Phase 5C): upload, see, remove.
 *
 * Always for one tenant, chosen first — a tenant's packages are its own, and
 * this screen never mixes two tenants' lists. Uploads run in the background
 * like the library's, shown in the activity bar; a package is usable once its
 * check job has made it Ready.
 */
export function PackagesView({
  tenants,
  initialTenantId,
  canManage,
}: {
  tenants: TenantSummary[];
  initialTenantId: string | null;
  canManage: boolean;
}) {
  const t = useTranslations();
  const choosable = tenants.filter((tenant) => tenant.status === 'ACTIVE');
  const [tenantId, setTenantId] = useState(
    initialTenantId && choosable.some((tenant) => tenant.id === initialTenantId)
      ? initialTenantId
      : choosable.length === 1
        ? choosable[0]!.id
        : '',
  );

  return (
    <div className="space-y-4">
      <Card title={t('autoconfig.packagesTenant')} description={t('autoconfig.packagesTenantHint')}>
        <div className="max-w-md">
          <Field label={t('autoconfig.owner')}>
            {(props) => (
              <select
                {...props}
                className={select}
                value={tenantId}
                onChange={(e) => setTenantId(e.target.value)}
              >
                <option value="">{t('autoconfig.chooseTenant')}</option>
                {choosable.map((tenant) => (
                  <option key={tenant.id} value={tenant.id}>
                    {tenant.kind === 'MSP_ROOT' ? t('autoconfig.ownerMsp') : tenant.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
      </Card>
      {tenantId && <TenantPackages key={tenantId} tenantId={tenantId} canManage={canManage} />}
    </div>
  );
}

/** One tenant's packages, and its uploads. */
function TenantPackages({ tenantId, canManage }: { tenantId: string; canManage: boolean }) {
  const t = useTranslations();
  const router = useRouter();
  const describeError = useApiError();
  const uploads = useUploads();
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [resumeTarget, setResumeTarget] = useState<PackageSummary | null>(null);
  const [removing, setRemoving] = useState<PackageSummary | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const packages = useApiResource<PackageSummary[]>(
    `/autoconfig/packages?tenantId=${encodeURIComponent(tenantId)}`,
  );
  const list = packages.state === 'ready' ? packages.data : [];
  const busy =
    uploads.active.length > 0 ||
    list.some((p) => p.state === 'RECEIVING' || p.state === 'VERIFYING');

  // While something is arriving or being checked, look again every few seconds.
  const { reload } = packages;
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(reload, 3000);
    return () => clearInterval(timer);
  }, [busy, reload]);

  function choose(file: File) {
    setFailure(null);
    if (file.size > PACKAGE_MAX_BYTES) {
      setFailure({
        code: 'autoconfig.package_too_large',
        status: 400,
        params: { maxBytes: PACKAGE_MAX_BYTES },
      });
      return;
    }
    uploads.start(file, resumeTarget ?? undefined, { kind: 'package', tenantId });
    setResumeTarget(null);
    setTimeout(reload, 1000);
  }

  async function remove() {
    if (!removing) return;
    setFailure(null);
    const result = await apiDelete(`/autoconfig/packages/${removing.id}`);
    setRemoving(null);
    if (!result.ok) return setFailure(result.error);
    reload();
    router.refresh();
  }

  return (
    <div className="space-y-4">
      {failure && <FormError>{describeError(failure)}</FormError>}
      <Card
        title={t('autoconfig.installerPackages')}
        description={t('autoconfig.packagesListHint')}
        actions={
          canManage ? (
            <>
              <input
                ref={fileInput}
                type="file"
                accept=".msi,.exe"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) choose(file);
                }}
              />
              <Button variant="secondary" onClick={() => fileInput.current?.click()}>
                {resumeTarget
                  ? t('autoconfig.packageResumeChoose', { filename: resumeTarget.filename })
                  : t('autoconfig.uploadPackage')}
              </Button>
            </>
          ) : null
        }
      >
        {packages.state === 'loading' && list.length === 0 ? (
          <p className="text-sm text-ink-muted">{t('common.loading')}</p>
        ) : packages.state === 'failed' ? (
          <Notice tone="error">{describeError(packages.error)}</Notice>
        ) : list.length === 0 ? (
          <p className="text-sm text-ink-muted">{t('autoconfig.packagesEmpty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-ink-muted">
                  <th className="py-2 pr-3 font-medium">{t('autoconfig.packageFile')}</th>
                  <th className="py-2 pr-3 font-medium">{t('autoconfig.packageSize')}</th>
                  <th className="py-2 pr-3 font-medium">{t('autoconfig.state')}</th>
                  <th className="py-2 pr-3 font-medium">{t('autoconfig.packageUsedBy')}</th>
                  <th className="py-2 pr-3 font-medium">{t('autoconfig.packageAddedBy')}</th>
                  {canManage && <th className="py-2 font-medium" />}
                </tr>
              </thead>
              <tbody>
                {list.map((item) => (
                  <tr key={item.id} className="border-t border-line align-top">
                    <td className="py-2 pr-3">
                      <div className="font-medium text-ink">{item.filename}</div>
                      <div className="text-xs text-ink-muted">
                        {item.kind}
                        {item.sha256 ? ` · sha256 ${item.sha256.slice(0, 16)}…` : ''}
                      </div>
                    </td>
                    <td className="py-2 pr-3 text-ink-muted">
                      {item.state === 'RECEIVING'
                        ? `${formatBytes(item.receivedBytes)} / ${formatBytes(item.sizeBytes)}`
                        : formatBytes(item.sizeBytes)}
                    </td>
                    <td className="py-2 pr-3">
                      <StatusBadge tone={TONE[item.state]}>
                        {t(`autoconfig.packageState.${item.state}`)}
                      </StatusBadge>
                      {item.state === 'FAILED' && item.errorCode && (
                        <div className="mt-1 text-xs text-error">
                          {describeError({ code: item.errorCode, status: 0 })}
                        </div>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-ink-muted">
                      {item.usedBy.length ? item.usedBy.map((u) => u.name).join(', ') : '—'}
                    </td>
                    <td className="py-2 pr-3 text-ink-muted">{item.createdBy ?? '—'}</td>
                    {canManage && (
                      <td className="py-2 text-right whitespace-nowrap">
                        {item.state === 'RECEIVING' && uploads.active.length === 0 && (
                          <Button
                            variant="quiet"
                            onClick={() => {
                              setResumeTarget(item);
                              fileInput.current?.click();
                            }}
                          >
                            {t('autoconfig.packageResume')}
                          </Button>
                        )}
                        {item.state !== 'VERIFYING' && item.usedBy.length === 0 && (
                          <Button variant="quiet" onClick={() => setRemoving(item)}>
                            {t('autoconfig.remove')}
                          </Button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {removing && (
        <Card title={t('autoconfig.removePackageTitle')}>
          <p className="mb-3 text-sm text-ink">
            {t('autoconfig.removePackageBody', { filename: removing.filename })}
          </p>
          <div className="flex gap-2">
            <Button onClick={() => void remove()}>{t('autoconfig.remove')}</Button>
            <Button variant="secondary" onClick={() => setRemoving(null)}>
              {t('common.cancel')}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

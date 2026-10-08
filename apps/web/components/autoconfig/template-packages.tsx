'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  PACKAGE_DEFAULT_ARGUMENTS,
  PACKAGES_PER_TEMPLATE_MAX,
  type PackageRunAs,
  type PackageSummary,
  type TemplatePackage,
} from '@velnox/shared';
import { Button, Field, TextInput } from '@/components/ui/form';
import { Card, Notice } from '@/components/ui/primitives';
import { useApiResource } from '@/components/server/use-api-resource';

const select =
  'block h-9 w-full rounded border border-line bg-surface-2 px-2.5 text-sm text-ink focus:border-accent focus:outline-none';

/**
 * A Windows template's installer packages (Phase 5C): which of the owner's
 * MSIs and EXEs run after Setup, in what order, with which arguments, how, and
 * whether a failure fails the build.
 *
 * Offered from the packages of the tenant that owns the template, and no
 * other: a template runs only its owner's. Someone who may see the template
 * but not its owner's packages — a customer looking at an MSP template — sees
 * that there are packages, not what they are.
 */
export function TemplatePackages({
  tenantId,
  packages,
  editable,
  guestAgent,
  onChange,
}: {
  tenantId: string;
  packages: TemplatePackage[];
  editable: boolean;
  guestAgent: boolean;
  onChange: (next: TemplatePackage[]) => void;
}) {
  const t = useTranslations();
  const available = useApiResource<PackageSummary[]>(
    `/autoconfig/packages?tenantId=${encodeURIComponent(tenantId)}`,
  );
  const [adding, setAdding] = useState('');

  const known = available.state === 'ready' ? available.data : [];
  const nameOf = (id: string) => known.find((item) => item.id === id);
  const ready = known.filter(
    (item) => item.state === 'READY' && !packages.some((p) => p.packageId === item.id),
  );

  const update = (index: number, change: Partial<TemplatePackage>) =>
    onChange(packages.map((p, i) => (i === index ? { ...p, ...change } : p)));
  const move = (index: number, by: number) => {
    const next = [...packages];
    const [item] = next.splice(index, 1);
    next.splice(index + by, 0, item!);
    onChange(next);
  };

  return (
    <Card
      title={t('autoconfig.installerPackages')}
      description={t('autoconfig.installerPackagesHint')}
    >
      <div className="space-y-3">
        {packages.length > 0 && !guestAgent && (
          <Notice tone="warn">{t('autoconfig.packagesNeedAgent')}</Notice>
        )}
        {packages.length === 0 && (
          <p className="text-sm text-ink-muted">{t('autoconfig.packagesNone')}</p>
        )}
        {packages.map((item, index) => {
          const found = nameOf(item.packageId);
          return (
            <div
              key={`${item.packageId}-${index}`}
              className="grid gap-3 rounded border border-line p-3 md:grid-cols-4"
            >
              <div className="md:col-span-4 flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium text-ink">
                  {index + 1}.{' '}
                  {found ? (
                    <>
                      {found.filename}{' '}
                      <span className="text-xs text-ink-muted">({found.kind})</span>
                      {found.state !== 'READY' && (
                        <span className="ml-2 text-xs text-danger">
                          {t('autoconfig.packageNotReady')}
                        </span>
                      )}
                    </>
                  ) : available.state === 'ready' ? (
                    <span className="text-ink-muted">{t('autoconfig.packageGone')}</span>
                  ) : (
                    <span className="text-ink-muted">{t('autoconfig.packageHidden')}</span>
                  )}
                </span>
                {editable && (
                  <span className="flex gap-1">
                    <Button variant="quiet" disabled={index === 0} onClick={() => move(index, -1)}>
                      {t('autoconfig.moveUp')}
                    </Button>
                    <Button
                      variant="quiet"
                      disabled={index === packages.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      {t('autoconfig.moveDown')}
                    </Button>
                    <Button
                      variant="quiet"
                      onClick={() => onChange(packages.filter((_, i) => i !== index))}
                    >
                      {t('autoconfig.removePackage')}
                    </Button>
                  </span>
                )}
              </div>
              <div className="md:col-span-2">
                <Field
                  label={t('autoconfig.packageArguments')}
                  hint={t('autoconfig.packageArgumentsHint')}
                >
                  {(props) => (
                    <TextInput
                      {...props}
                      value={item.arguments}
                      disabled={!editable}
                      maxLength={1000}
                      onChange={(e) => update(index, { arguments: e.target.value })}
                    />
                  )}
                </Field>
              </div>
              <Field label={t('autoconfig.packageRunAs')}>
                {(props) => (
                  <select
                    {...props}
                    className={select}
                    value={item.runAs}
                    disabled={!editable}
                    onChange={(e) => update(index, { runAs: e.target.value as PackageRunAs })}
                  >
                    <option value="SYSTEM">{t('autoconfig.runAsSystem')}</option>
                    <option value="ADMINISTRATOR">{t('autoconfig.runAsAdministrator')}</option>
                  </select>
                )}
              </Field>
              <label className="flex items-end gap-2 pb-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={item.required}
                  disabled={!editable}
                  onChange={(e) => update(index, { required: e.target.checked })}
                />
                {t('autoconfig.packageRequired')}
              </label>
            </div>
          );
        })}

        {editable && packages.length < PACKAGES_PER_TEMPLATE_MAX && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-64 flex-1">
              <Field label={t('autoconfig.addPackage')}>
                {(props) => (
                  <select
                    {...props}
                    className={select}
                    value={adding}
                    onChange={(e) => setAdding(e.target.value)}
                  >
                    <option value="">
                      {ready.length ? t('autoconfig.choosePackage') : t('autoconfig.noPackages')}
                    </option>
                    {ready.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.filename}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            </div>
            <Button
              variant="secondary"
              disabled={!adding}
              onClick={() => {
                const chosen = known.find((item) => item.id === adding);
                if (!chosen) return;
                onChange([
                  ...packages,
                  {
                    packageId: chosen.id,
                    arguments: PACKAGE_DEFAULT_ARGUMENTS[chosen.kind],
                    runAs: 'SYSTEM',
                    required: true,
                  },
                ]);
                setAdding('');
              }}
            >
              {t('autoconfig.add')}
            </Button>
            <Link
              href={`/autoconfig/packages?tenantId=${encodeURIComponent(tenantId)}`}
              className="pb-2 text-sm text-accent hover:underline"
            >
              {t('autoconfig.managePackages')}
            </Link>
          </div>
        )}
      </div>
    </Card>
  );
}

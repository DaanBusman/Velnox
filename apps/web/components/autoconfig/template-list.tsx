'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { TemplateSummary } from '@velnox/shared';
import { apiDelete, apiPost, type ApiFailure } from '@/lib/client-api';
import { useApiError } from '@/lib/use-api-error';
import type { TenantSummary } from '@/lib/session-types';
import { Button, Field, FormError, TextInput } from '@/components/ui/form';
import { Card, Notice, StatusBadge } from '@/components/ui/primitives';

/**
 * The templates this account may see.
 *
 * An MSP template shows who owns it, so a customer can tell the MSP's from
 * their own; a template with secrets missing says so on the row, because it
 * cannot build a VM until someone sets them. Change and delete appear only
 * where the account may change that template — seeing an MSP template is not
 * editing it.
 */
export function TemplateList({
  templates,
  tenants,
  canManage,
  canProvision,
}: {
  templates: TemplateSummary[];
  tenants: TenantSummary[];
  canManage: boolean;
  canProvision: boolean;
}) {
  const t = useTranslations();
  const router = useRouter();
  const describeError = useApiError();
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [cloning, setCloning] = useState<TemplateSummary | null>(null);
  const [cloneTenant, setCloneTenant] = useState('');
  const [cloneName, setCloneName] = useState('');
  const [removing, setRemoving] = useState<TemplateSummary | null>(null);
  const [pending, setPending] = useState(false);

  const active = tenants.filter((tenant) => tenant.status === 'ACTIVE');

  async function clone() {
    if (!cloning) return;
    setPending(true);
    setFailure(null);
    const result = await apiPost<TemplateSummary>(`/autoconfig/templates/${cloning.id}/clone`, {
      tenantId: cloneTenant,
      name: cloneName.trim(),
    });
    setPending(false);
    if (!result.ok) return setFailure(result.error);
    setCloning(null);
    router.push(`/autoconfig/${result.data.id}`);
  }

  async function remove() {
    if (!removing) return;
    setPending(true);
    setFailure(null);
    const result = await apiDelete(`/autoconfig/templates/${removing.id}`);
    setPending(false);
    if (!result.ok) return setFailure(result.error);
    setRemoving(null);
    router.refresh();
  }

  const select =
    'block h-9 w-full rounded border border-line bg-surface-2 px-2.5 text-sm text-ink focus:border-accent focus:outline-none';

  return (
    <div className="space-y-4">
      {failure && <FormError>{describeError(failure)}</FormError>}

      {canManage && (
        <div className="flex flex-wrap gap-2">
          <Link href="/autoconfig/new?family=WINDOWS">
            <Button>{t('autoconfig.newWindows')}</Button>
          </Link>
          <Link href="/autoconfig/new?family=LINUX">
            <Button variant="secondary">{t('autoconfig.newLinux')}</Button>
          </Link>
        </div>
      )}

      {cloning && (
        <Card
          title={t('autoconfig.cloneTitle', { name: cloning.name })}
          description={t('autoconfig.cloneDescription')}
        >
          <div className="space-y-3">
            <Field label={t('autoconfig.owner')}>
              {(props) => (
                <select
                  {...props}
                  className={select}
                  value={cloneTenant}
                  onChange={(event) => setCloneTenant(event.target.value)}
                >
                  <option value="">{t('autoconfig.chooseTenant')}</option>
                  {active.map((tenant) => (
                    <option key={tenant.id} value={tenant.id}>
                      {tenant.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label={t('autoconfig.name')}>
              {(props) => (
                <TextInput
                  {...props}
                  value={cloneName}
                  onChange={(event) => setCloneName(event.target.value)}
                />
              )}
            </Field>
            <div className="flex gap-2">
              <Button
                onClick={() => void clone()}
                pending={pending}
                disabled={!cloneTenant || !cloneName.trim()}
              >
                {t('autoconfig.clone')}
              </Button>
              <Button variant="secondary" onClick={() => setCloning(null)}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {removing && (
        <Card title={t('autoconfig.removeTitle', { name: removing.name })}>
          <p className="mb-3 text-sm text-ink-muted">{t('autoconfig.removeBody')}</p>
          <div className="flex gap-2">
            <Button onClick={() => void remove()} pending={pending}>
              {t('autoconfig.remove')}
            </Button>
            <Button variant="secondary" onClick={() => setRemoving(null)}>
              {t('common.cancel')}
            </Button>
          </div>
        </Card>
      )}

      <Card title={t('autoconfig.listTitle')} bodyClassName="overflow-x-auto">
        {templates.length === 0 ? (
          <p className="px-4 py-6 text-sm text-ink-muted">{t('autoconfig.empty')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-surface-2/60 text-left text-xs text-ink-muted">
              <tr>
                <th className="px-4 py-2 font-medium">{t('autoconfig.name')}</th>
                <th className="px-4 py-2 font-medium">{t('autoconfig.family')}</th>
                <th className="px-4 py-2 font-medium">{t('autoconfig.owner')}</th>
                <th className="px-4 py-2 font-medium">{t('autoconfig.visibility')}</th>
                <th className="px-4 py-2 font-medium">{t('autoconfig.state')}</th>
                <th className="px-4 py-2 font-medium">{t('autoconfig.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {templates.map((template) => (
                <tr key={template.id} className="border-t border-line/70 align-top">
                  <td className="px-4 py-2.5">
                    <Link
                      href={`/autoconfig/${template.id}`}
                      className="font-medium text-ink hover:underline"
                    >
                      {template.name}
                    </Link>
                    {template.clonedFromName && (
                      <p className="text-xs text-ink-muted">
                        {t('autoconfig.clonedFrom', { name: template.clonedFromName })}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {template.family === 'WINDOWS'
                      ? t('autoconfig.windows')
                      : t('autoconfig.linux')}
                  </td>
                  <td className="px-4 py-2.5">
                    {template.ownedByMsp ? t('autoconfig.ownerMsp') : template.tenantName}
                  </td>
                  <td className="px-4 py-2.5">
                    {template.visibility === 'SHARED' && template.ownedByMsp
                      ? t('autoconfig.visibilityShared')
                      : t('autoconfig.visibilityPrivate')}
                  </td>
                  <td className="px-4 py-2.5">
                    {template.secretsMissing.length > 0 ? (
                      <StatusBadge tone="warn">{t('autoconfig.incomplete')}</StatusBadge>
                    ) : (
                      <StatusBadge tone="ok">{t('autoconfig.ready')}</StatusBadge>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {canProvision && template.secretsMissing.length === 0 && (
                        <Link href={`/provisioning/new?templateId=${template.id}`}>
                          <Button variant="quiet">{t('autoconfig.build')}</Button>
                        </Link>
                      )}
                      {canManage && (
                        <Button
                          variant="quiet"
                          onClick={() => {
                            setCloning(template);
                            setCloneName(t('autoconfig.copyOf', { name: template.name }));
                            setCloneTenant('');
                          }}
                        >
                          {t('autoconfig.clone')}
                        </Button>
                      )}
                      {template.canEdit && (
                        <Button variant="quiet" onClick={() => setRemoving(template)}>
                          {t('autoconfig.remove')}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {!canManage && <Notice>{t('autoconfig.readOnly')}</Notice>}
    </div>
  );
}

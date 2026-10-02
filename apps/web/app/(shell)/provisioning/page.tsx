import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Button } from '@/components/ui/form';
import { Card, Notice, PageHeader, StatusBadge } from '@/components/ui/primitives';
import { getSession, listProvisionings } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('nav.provisioning') };
}

const tone = (state: string) =>
  state === 'SUCCEEDED'
    ? 'ok'
    : state === 'FAILED'
      ? 'error'
      : state === 'CANCELLED'
        ? 'neutral'
        : 'warn';

export default async function ProvisioningListPage() {
  const [t, session, rows] = await Promise.all([
    getTranslations(),
    getSession(),
    listProvisionings(),
  ]);
  const canProvision = session?.user.permissions.includes('workloads.provision') ?? false;

  return (
    <>
      <PageHeader
        title={t('nav.provisioning')}
        description={t('provisioning.subtitle')}
        actions={
          canProvision ? (
            <Link href="/provisioning/new">
              <Button>{t('provisioning.newTitle')}</Button>
            </Link>
          ) : undefined
        }
      />
      {!rows.ok ? (
        <Notice tone={rows.code === 'authz.forbidden' ? 'warn' : 'error'}>
          {rows.code === 'authz.forbidden'
            ? t('common.requiresPermission', { permission: 'workloads.read' })
            : t('errors.generic')}
        </Notice>
      ) : (
        <Card bodyClassName="overflow-x-auto">
          {rows.data.length === 0 ? (
            <p className="px-4 py-6 text-sm text-ink-muted">{t('provisioning.empty')}</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-surface-2/60 text-left text-xs text-ink-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">{t('provisioning.hostname')}</th>
                  <th className="px-4 py-2 font-medium">{t('provisioning.template')}</th>
                  <th className="px-4 py-2 font-medium">{t('provisioning.cluster')}</th>
                  <th className="px-4 py-2 font-medium">{t('provisioning.state')}</th>
                  <th className="px-4 py-2 font-medium">{t('provisioning.requestedBy')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.data.map((row) => (
                  <tr key={row.id} className="border-t border-line/70">
                    <td className="px-4 py-2.5">
                      <Link
                        href={`/provisioning/${row.id}`}
                        className="font-medium text-ink hover:underline"
                      >
                        {row.hostname}
                      </Link>
                      {row.vmid !== null && (
                        <span className="ml-2 text-xs text-ink-muted">VM {row.vmid}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">{row.templateName}</td>
                    <td className="px-4 py-2.5">
                      {row.clusterName} · {row.node}
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusBadge tone={tone(row.state)}>
                        {t(`provisioning.states.${row.state}`)}
                      </StatusBadge>
                    </td>
                    <td className="px-4 py-2.5">{row.requestedByLabel ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
    </>
  );
}

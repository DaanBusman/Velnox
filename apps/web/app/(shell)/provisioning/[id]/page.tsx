import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Card, KeyValue, Notice, PageHeader, StatusBadge } from '@/components/ui/primitives';
import { RevealPanel } from '@/components/provisioning/reveal-panel';
import { getProvisioning, getSession } from '@/lib/session';
import { messageValues } from '@/lib/message-values';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props) {
  const { id } = await params;
  const row = await getProvisioning(id);
  const t = await getTranslations();
  return { title: row.ok ? row.data.hostname : t('nav.provisioning') };
}

const tone = (state: string) =>
  state === 'SUCCEEDED'
    ? 'ok'
    : state === 'FAILED'
      ? 'error'
      : state === 'CANCELLED'
        ? 'neutral'
        : 'warn';

export default async function ProvisioningPage({ params }: Props) {
  const { id } = await params;
  const [t, format, session, row] = await Promise.all([
    getTranslations(),
    getFormatter(),
    getSession(),
    getProvisioning(id),
  ]);
  if (!row.ok && row.code === 'not_found') notFound();
  if (!row.ok) {
    return (
      <>
        <PageHeader title={t('nav.provisioning')} />
        <Notice tone="error">{t('errors.generic')}</Notice>
      </>
    );
  }
  const p = row.data;
  const when = (value: string | null) =>
    value ? format.dateTime(new Date(value), { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  const canReveal = session?.user.permissions.includes('clusters.manage') ?? false;
  const errorKey = p.errorCode ? `errors.${p.errorCode}` : null;

  return (
    <>
      <PageHeader
        title={p.hostname}
        description={t('provisioning.detailDescription', {
          template: p.templateName,
          cluster: p.clusterName,
        })}
      />
      <div className="space-y-4">
        {p.state === 'FAILED' && (
          <Notice tone="error" title={t('provisioning.failedTitle')}>
            {errorKey && t.has(errorKey)
              ? t(errorKey, messageValues(p.errorParams))
              : t('errors.generic')}
          </Notice>
        )}
        <Card title={t('provisioning.recordTitle')}>
          <dl>
            <KeyValue label={t('provisioning.state')}>
              <StatusBadge tone={tone(p.state)}>{t(`provisioning.states.${p.state}`)}</StatusBadge>
              {p.currentStep && (
                <span className="ml-2 text-xs text-ink-muted">
                  {t.has(`provisioning.steps.${p.currentStep}`)
                    ? t(`provisioning.steps.${p.currentStep}`)
                    : p.currentStep}
                  {p.progressPct !== null && ` · ${p.progressPct}%`}
                </span>
              )}
            </KeyValue>
            <KeyValue label={t('provisioning.vmid')}>{p.vmid ?? '—'}</KeyValue>
            <KeyValue label={t('provisioning.cluster')}>
              {p.clusterId ? (
                <Link href={`/clusters/${p.clusterId}`}>{p.clusterName}</Link>
              ) : (
                p.clusterName
              )}{' '}
              · {p.node}
            </KeyValue>
            <KeyValue label={t('provisioning.template')}>
              {p.templateId ? (
                <Link href={`/autoconfig/${p.templateId}`}>{p.templateName}</Link>
              ) : (
                p.templateName
              )}
            </KeyValue>
            <KeyValue label={t('provisioning.addresses')}>
              {p.addresses.length ? p.addresses.join(', ') : '—'}
            </KeyValue>
            <KeyValue label={t('provisioning.requestedBy')}>{p.requestedByLabel ?? '—'}</KeyValue>
            <KeyValue label={t('provisioning.started')}>{when(p.startedAt)}</KeyValue>
            <KeyValue label={t('provisioning.finished')}>{when(p.finishedAt)}</KeyValue>
            <KeyValue label={t('provisioning.duration')}>
              {p.durationSeconds !== null
                ? t('provisioning.minutes', {
                    minutes: Math.max(1, Math.round(p.durationSeconds / 60)),
                  })
                : '—'}
            </KeyValue>
            <KeyValue label={t('provisioning.delivery')}>
              {p.credentialDelivery === 'ENCRYPTED_PDF'
                ? t('autoconfig.deliveryPdf')
                : t('autoconfig.deliveryVelnox')}
            </KeyValue>
            <KeyValue label={t('provisioning.notified')}>{when(p.notifiedAt)}</KeyValue>
            {p.jobId && (
              <KeyValue label={t('provisioning.job')}>
                <Link href={`/jobs/${p.jobId}`}>{t('provisioning.followJob')}</Link>
              </KeyValue>
            )}
          </dl>
        </Card>
        {canReveal && <RevealPanel provisioningId={p.id} available={p.credentialsAvailable} />}
      </div>
    </>
  );
}

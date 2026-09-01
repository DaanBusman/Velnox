import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Card, KeyValue, Mono, Notice, PageHeader } from '@/components/ui/primitives';
import { tryGetSourceOffer, tryGetSystemInfo } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('about.title') };
}

/**
 * Settings > About.
 *
 * This page is how Velnox discharges AGPL section 13: anyone using this
 * installation can see the exact build that is running and follow a link to its
 * Corresponding Source. It is reachable by every user, not only administrators,
 * because the obligation runs to everyone who interacts with the software over
 * the network — see NOTICE and docs/architecture.md section 15.
 */
export default async function AboutPage() {
  const [t, source, info] = await Promise.all([
    getTranslations(),
    tryGetSourceOffer(),
    tryGetSystemInfo(),
  ]);

  if (!source) {
    return (
      <>
        <PageHeader title={t('about.title')} description={t('about.subtitle')} />
        <Notice tone="error">{t('system.unreachable')}</Notice>
      </>
    );
  }

  const product = source.product;

  return (
    <>
      <PageHeader title={t('about.title')} description={t('about.subtitle')} />

      <div className="space-y-5">
        <Card title={t('about.title')}>
          <dl>
            <KeyValue label={t('about.product')}>{product}</KeyValue>
            <KeyValue label={t('about.version')}>
              <Mono>{source.version}</Mono>
            </KeyValue>
            <KeyValue label={t('about.commit')}>
              <Mono>{source.commit}</Mono>
            </KeyValue>
            <KeyValue label={t('about.builtAt')}>
              {source.builtAt ?? t('common.notAvailable')}
            </KeyValue>
            <KeyValue label={t('about.environment')}>
              {info?.environment ?? t('common.unknown')}
            </KeyValue>
            <KeyValue label={t('about.license')}>
              <Mono>{source.license}</Mono>
            </KeyValue>
          </dl>
        </Card>

        <Card title={t('about.sourceHeading')}>
          <div className="space-y-3">
            <p className="text-sm text-ink-muted">{t('about.agplNotice', { product })}</p>

            <Notice tone={source.modified ? 'warn' : 'ok'}>
              {source.modified ? t('about.modifiedNotice') : t('about.unmodifiedNotice')}
            </Notice>

            <p>
              <a
                href={source.url}
                rel="noreferrer noopener"
                target="_blank"
                className="inline-flex h-8 items-center rounded border border-line-strong bg-surface-2 px-3 text-xs font-medium text-ink hover:bg-surface"
              >
                {t('about.viewSource')}
              </a>
            </p>

            <p className="font-mono text-xs break-all text-ink-muted">{source.url}</p>
          </div>
        </Card>

        <Card title={t('about.trademarkNotice', { product })}>
          <p className="text-xs text-ink-muted">
            Proxmox®, VMware®, Microsoft®, Hyper-V®, Ceph®, Debian®, Docker® and PostgreSQL® are
            trademarks of their respective owners. {product} is not affiliated with, endorsed by, or
            sponsored by any of them.
          </p>
        </Card>
      </div>
    </>
  );
}

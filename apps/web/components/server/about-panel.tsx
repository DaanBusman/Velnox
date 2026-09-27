'use client';

import { useFormatter, useTranslations } from 'next-intl';
import type { SourceOfferResponse, SystemInfoResponse } from '@velnox/shared';
import { Card, KeyValue, Mono, Notice } from '@/components/ui/primitives';
import { useApiResource } from './use-api-resource';
import { PanelError, PanelLoading } from './panel-state';

/**
 * About this server.
 *
 * Which build is running, under which licence, and where its source is. It used
 * to be a sidebar entry called Settings that led to a page of read-only facts,
 * which is not what the word settings means — so the facts came here, to the
 * window that is already about this installation, and the sidebar entry became
 * an actual settings page.
 *
 * The licence notices are the reason this is more than a version number. AGPLv3
 * section 13 requires the Corresponding Source to be reachable by anyone
 * interacting with the software over a network, and section 7(b) requires the
 * attribution to be preserved. This window needs `system.manage`, so it cannot
 * be the only place either appears: the Settings page carries the same offer for
 * everyone, and the footer links to it on every screen. This is the fuller
 * version for whoever administers the box.
 */
export function AboutPanel() {
  const t = useTranslations();
  const format = useFormatter();
  const source = useApiResource<SourceOfferResponse>('/system/source');
  const info = useApiResource<SystemInfoResponse>('/system/info');

  if (source.state === 'loading' || info.state === 'loading') return <PanelLoading />;
  if (source.state === 'failed') return <PanelError error={source.error} />;

  const build = source.data;
  const product = build.product;

  return (
    <div className="space-y-5">
      <Card title={t('about.buildHeading')} description={t('about.buildBody')}>
        <dl>
          <KeyValue label={t('about.product')}>{product}</KeyValue>
          <KeyValue label={t('about.version')}>
            <Mono>{build.version}</Mono>
          </KeyValue>
          <KeyValue label={t('about.commit')}>
            <Mono>{build.commit}</Mono>
          </KeyValue>
          <KeyValue label={t('about.builtAt')}>
            {build.builtAt
              ? format.dateTime(new Date(build.builtAt), { dateStyle: 'long', timeStyle: 'short' })
              : t('common.notAvailable')}
          </KeyValue>
          <KeyValue label={t('about.environment')}>
            {/* A failed info read is not a failed panel: the licence notices
                below matter more than the word "production". */}
            {info.state === 'ready' ? info.data.environment : t('common.unknown')}
          </KeyValue>
          <KeyValue label={t('about.license')}>
            <Mono>{build.license}</Mono>
          </KeyValue>
        </dl>
      </Card>

      {/*
        The attribution required by AGPLv3 section 7(b), rendered verbatim from
        the API rather than composed here.

        Not translated, and not built from `product`: it is a legal notice, and
        its wording is the thing the licence term names. A rebranded installation
        shows its own name everywhere else and still shows this. See NOTICE.
      */}
      <Card title={t('about.attributionHeading')}>
        <p className="text-sm text-ink">{build.attribution}</p>
        <p className="mt-2 text-xs text-ink-muted">{t('about.attributionBody')}</p>
      </Card>

      <Card title={t('about.sourceHeading')}>
        <div className="space-y-3">
          <p className="text-sm text-ink-muted">{t('about.agplNotice', { product })}</p>

          <Notice tone={build.modified ? 'warn' : 'ok'}>
            {build.modified ? t('about.modifiedNotice') : t('about.unmodifiedNotice')}
          </Notice>

          <p>
            <a
              href={build.url}
              rel="noreferrer noopener"
              target="_blank"
              className="inline-flex h-8 items-center rounded border border-line-strong bg-surface-2 px-3 text-xs font-medium text-ink hover:bg-surface"
            >
              {t('about.viewSource')}
            </a>
          </p>

          <p className="font-mono text-xs break-all text-ink-muted">{build.url}</p>
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
  );
}

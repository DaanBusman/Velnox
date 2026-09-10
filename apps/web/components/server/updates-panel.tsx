'use client';

import { useFormatter, useTranslations } from 'next-intl';
import type { SourceOfferResponse } from '@velnox/shared';
import { CopyField } from '@/components/copy-field';
import { Card, KeyValue, Mono, Notice } from '@/components/ui/primitives';
import { useApiResource } from './use-api-resource';
import { PanelError, PanelLoading } from './panel-state';

/**
 * Which build is running, and how to move to a newer one.
 *
 * Deliberately not a check-for-updates button. Velnox is installed on
 * management networks that frequently cannot reach the internet, so a version
 * check would fail on exactly the installations most likely to open this panel —
 * and a "you are up to date" that really means "I could not ask" is worse than
 * no answer. It would also mean the appliance calling out to a third party on a
 * schedule, which is not something an MSP console should start doing without
 * being asked.
 *
 * So this reports the build honestly and hands over the procedure, in the order
 * that makes it reversible. Step one is the one people skip and the one that
 * makes the other two safe.
 */
export function UpdatesPanel() {
  const t = useTranslations();
  const format = useFormatter();
  const source = useApiResource<SourceOfferResponse>('/system/source');

  if (source.state === 'loading') return <PanelLoading />;
  if (source.state === 'failed') return <PanelError error={source.error} />;

  const build = source.data;

  return (
    <div className="space-y-5">
      <Card title={t('server.updates.runningTitle')} description={t('server.updates.runningBody')}>
        <dl>
          <KeyValue label={t('about.product')}>{build.product}</KeyValue>
          <KeyValue label={t('about.version')}>
            <Mono>{build.version}</Mono>
          </KeyValue>
          <KeyValue label={t('about.commit')}>
            <Mono>{build.commit}</Mono>
          </KeyValue>
          <KeyValue label={t('about.builtAt')}>
            {build.builtAt
              ? format.dateTime(new Date(build.builtAt), {
                  dateStyle: 'long',
                  timeStyle: 'short',
                })
              : t('common.notAvailable')}
          </KeyValue>
        </dl>
      </Card>

      <Notice tone="warn" title={t('server.updates.backupTitle')}>
        {t('server.updates.backupBody')}
      </Notice>

      <Card title={t('server.updates.procedureTitle')} description={t('server.updates.procedureBody')}>
        <ol className="space-y-4">
          <li>
            <CopyField
              label={t('server.updates.step1')}
              value={
                "cd /opt/velnox && sudo sh -c 'docker compose -f deploy/compose/docker-compose.yml " +
                '--env-file .env exec -T postgres pg_dump -U velnox -d velnox --format=custom > ' +
                '"/var/backups/velnox-$(date +%F).dump"\''
              }
              hint={t('server.updates.step1Hint')}
            />
          </li>
          <li>
            <CopyField
              label={t('server.updates.step2')}
              value="cd /opt/velnox && sudo git fetch && sudo git log --oneline HEAD..origin/main"
              hint={t('server.updates.step2Hint')}
            />
          </li>
          <li>
            <CopyField
              label={t('server.updates.step3')}
              value="cd /opt/velnox && sudo git pull && sudo bash install.sh --non-interactive"
              hint={t('server.updates.step3Hint')}
            />
          </li>
        </ol>

        <p className="mt-4 text-sm text-ink-muted">{t('server.updates.afterwards')}</p>
      </Card>

      <Card title={t('server.updates.verifyTitle')} description={t('server.updates.verifyBody')}>
        <CopyField
          label={t('server.updates.verifyLabel')}
          value="cd /opt/velnox && bash scripts/verify-stack.sh https://$(grep -m1 '^VELNOX_SITE_ADDRESS=' .env | cut -d= -f2)"
        />
      </Card>

      <Card title={t('about.sourceHeading')}>
        <p className="text-sm text-ink-muted">{t('about.agplNotice', { product: build.product })}</p>
        <p className="mt-3">
          <a
            href={build.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-accent underline underline-offset-2"
          >
            {t('about.viewSource')}
          </a>
        </p>
      </Card>
    </div>
  );
}

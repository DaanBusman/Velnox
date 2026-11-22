'use client';

import { useTranslations } from 'next-intl';
import type { SourceOfferResponse } from '@velnox/shared';
import { CopyField } from '@/components/copy-field';
import { Card, KeyValue, Mono, Notice } from '@/components/ui/primitives';
import { useApiResource } from './use-api-resource';
import { PanelError, PanelLoading } from './panel-state';
import { UpdateCheckCard } from './update-check-card';

/**
 * Which build is running, whether a newer one exists, and how to move to it.
 *
 * Until 0.7.21 this was deliberately not a check for updates: Velnox runs on
 * management networks that often cannot reach the internet, and a "you are up
 * to date" that really means "I could not ask" is worse than no answer. The
 * check that came (ADR-060) answers both objections rather than ignoring them:
 * "could not ask" is shown as that, with why, and the check can be switched
 * off here. It sends nothing but the request for one file.
 *
 * Then the procedure, in the order that makes it reversible. Step one is the
 * one people skip and the one that makes the other two safe.
 *
 * It names the running version and nothing else about the build. The rest — the
 * commit, when it was built, the licence and the source offer — is About this
 * server, one tab along. Two panels reporting the same four facts is two places
 * to change when one of them gains a fifth.
 */
export function UpdatesPanel() {
  const t = useTranslations();
  const source = useApiResource<SourceOfferResponse>('/system/source');

  if (source.state === 'loading') return <PanelLoading />;
  if (source.state === 'failed') return <PanelError error={source.error} />;

  const build = source.data;

  return (
    <div className="space-y-5">
      <UpdateCheckCard />

      <Card title={t('server.updates.runningTitle')} description={t('server.updates.runningBody')}>
        <dl>
          <KeyValue label={t('about.product')}>{build.product}</KeyValue>
          <KeyValue label={t('about.version')}>
            <Mono>{build.version}</Mono>
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
              value="sudo velnox update --check"
              hint={t('server.updates.step1Hint')}
            />
          </li>
          <li>
            <CopyField
              label={t('server.updates.step2')}
              value="sudo velnox update"
              hint={t('server.updates.step2Hint')}
            />
          </li>
        </ol>

        <p className="mt-4 text-sm text-ink-muted">{t('server.updates.afterwards')}</p>
      </Card>

      <Card title={t('server.updates.verifyTitle')} description={t('server.updates.verifyBody')}>
        <CopyField
          label={t('server.updates.verifyLabel')}
          value="sudo velnox check"
        />
      </Card>

    </div>
  );
}

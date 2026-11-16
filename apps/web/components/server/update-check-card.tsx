'use client';

import { useEffect, useState } from 'react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import type { UpdateStatusResponse } from '@velnox/shared';
import { apiGet, apiPost, apiPut, type ApiFailure } from '@/lib/client-api';
import { useApiError } from '@/lib/use-api-error';
import { Button, FormError } from '@/components/ui/form';
import { Card, KeyValue, Mono, Notice, StatusBadge } from '@/components/ui/primitives';
import { PanelError, PanelLoading } from './panel-state';

/** Tells the sidebar's notice that the answer changed, so it does not wait an hour. */
export const UPDATE_STATUS_EVENT = 'velnox:update-status';

/**
 * Is there a newer Velnox (0.7.21).
 *
 * Four answers, kept apart on purpose: switched off; could not ask, with why
 * and when it last could; up to date, as of when; and a newer version, with
 * the advisories that concern this installation, critical first. "Could not
 * ask" is never shown as "up to date" — an installation without internet sees
 * that it cannot check, not that it is current.
 */
export function UpdateCheckCard() {
  const t = useTranslations();
  const format = useFormatter();
  const locale = useLocale() === 'nl' ? 'nl' : 'en';
  const describeError = useApiError();
  const [status, setStatus] = useState<UpdateStatusResponse | null>(null);
  const [loadFailure, setLoadFailure] = useState<ApiFailure | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [pending, setPending] = useState<'check' | 'toggle' | null>(null);

  useEffect(() => {
    void apiGet<UpdateStatusResponse>('/system/update').then((response) => {
      if (response.ok) setStatus(response.data);
      else setLoadFailure(response.error);
    });
  }, []);

  if (loadFailure) return <PanelError error={loadFailure} />;
  if (!status) return <PanelLoading />;

  const show = (next: UpdateStatusResponse) => {
    setStatus(next);
    window.dispatchEvent(new CustomEvent(UPDATE_STATUS_EVENT, { detail: next }));
  };
  const when = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });

  async function checkNow() {
    setPending('check');
    setFailure(null);
    const response = await apiPost<UpdateStatusResponse>('/system/update/check');
    setPending(null);
    if (response.ok) show(response.data);
    else setFailure(response.error);
  }

  async function toggle() {
    setPending('toggle');
    setFailure(null);
    const response = await apiPut<UpdateStatusResponse>('/system/update', { enabled: !status!.enabled });
    setPending(null);
    if (!response.ok) {
      setFailure(response.error);
      return;
    }
    show(response.data);
    // Switched on: ask now rather than within the quarter of an hour.
    if (response.data.enabled) await checkNow();
  }

  const headline = !status.enabled ? (
    <StatusBadge tone="neutral">{t('server.updateCheck.off')}</StatusBadge>
  ) : status.updateAvailable ? (
    <StatusBadge tone={status.critical ? 'error' : 'warn'}>
      {t(status.critical ? 'server.updateCheck.criticalAvailable' : 'server.updateCheck.available', {
        version: status.latest ?? '',
      })}
    </StatusBadge>
  ) : status.error && !status.succeededAt ? (
    <StatusBadge tone="unknown">{t('server.updateCheck.unknown')}</StatusBadge>
  ) : status.succeededAt ? (
    <StatusBadge tone="ok">{t('server.updateCheck.current')}</StatusBadge>
  ) : (
    <StatusBadge tone="unknown">{t('server.updateCheck.notYet')}</StatusBadge>
  );

  return (
    <Card
      title={t('server.updateCheck.title')}
      description={t('server.updateCheck.body')}
      actions={headline}
    >
      <div className="space-y-3">
        {status.enabled && status.updateAvailable && status.advisories.length > 0 && (
          <ul className="space-y-2">
            {status.advisories.map((advisory) => (
              <li key={advisory.id}>
                <Notice
                  tone={advisory.severity === 'critical' ? 'error' : 'warn'}
                  title={`${t(`server.updateCheck.severity.${advisory.severity}`)} · ${advisory.title[locale]}`}
                >
                  {t('server.updateCheck.fixedIn', { version: advisory.fixedIn, id: advisory.id })}
                  {advisory.url && (
                    <>
                      {' '}
                      <a
                        href={advisory.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="underline underline-offset-2"
                      >
                        {t('server.updateCheck.readMore')}
                      </a>
                    </>
                  )}
                </Notice>
              </li>
            ))}
          </ul>
        )}

        {status.enabled && status.error && (
          <Notice tone="warn" title={t('server.updateCheck.failedTitle')}>
            {t(`server.updateCheck.errors.${status.error}`)}
            {status.errorDetail ? ` (${status.errorDetail})` : ''}{' '}
            {status.succeededAt
              ? t('server.updateCheck.lastGood', { when: when(status.succeededAt) })
              : t('server.updateCheck.neverGood')}
          </Notice>
        )}

        <dl>
          <KeyValue label={t('server.updateCheck.running')}>
            <Mono>{status.running}</Mono>
          </KeyValue>
          {status.latest && (
            <KeyValue label={t('server.updateCheck.latest')}>
              <Mono>{status.latest}</Mono>
            </KeyValue>
          )}
          <KeyValue label={t('server.updateCheck.checkedAt')}>
            {status.checkedAt ? when(status.checkedAt) : t('server.updateCheck.never')}
          </KeyValue>
          <KeyValue label={t('server.updateCheck.source')}>
            <Mono>{status.source}</Mono>
          </KeyValue>
        </dl>

        <p className="text-xs text-ink-muted">
          {t(status.enabled ? 'server.updateCheck.onHint' : 'server.updateCheck.offHint')}
        </p>

        {failure && <FormError>{describeError(failure)}</FormError>}

        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" pending={pending === 'check'} disabled={pending !== null} onClick={() => void checkNow()}>
            {t('server.updateCheck.checkNow')}
          </Button>
          <Button variant="quiet" pending={pending === 'toggle'} disabled={pending !== null} onClick={() => void toggle()}>
            {t(status.enabled ? 'server.updateCheck.switchOff' : 'server.updateCheck.switchOn')}
          </Button>
        </div>
      </div>
    </Card>
  );
}

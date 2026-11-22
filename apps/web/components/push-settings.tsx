'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Card, Notice } from '@/components/ui/primitives';
import { Button, FormError } from '@/components/ui/form';
import { useApiError } from '@/lib/use-api-error';
import type { ApiFailure } from '@/lib/client-api';
import { disablePush, enablePush, readPushState, testPush, type PushState } from '@/lib/pwa/push';

/**
 * Approval notifications on this device (ADR-062). Per browser, like the rest
 * of this window, and proven with a real message rather than assumed.
 */
export function PushSettings() {
  const t = useTranslations('push');
  const locale = useLocale();
  const describeError = useApiError();
  const [state, setState] = useState<PushState>('loading');
  const [busy, setBusy] = useState<'toggle' | 'test' | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [message, setMessage] = useState<'testSent' | 'failed' | null>(null);

  useEffect(() => {
    readPushState()
      .then(setState)
      .catch(() => setState('unsupported'));
  }, []);

  async function run(kind: 'toggle' | 'test', action: () => ReturnType<typeof testPush>) {
    setBusy(kind);
    setFailure(null);
    setMessage(null);
    try {
      const result = await action();
      if (result.ok) {
        if (kind === 'test') setMessage('testSent');
      } else if (result.error) {
        setFailure(result.error);
      } else if (!result.denied) {
        setMessage('failed');
      }
    } catch {
      setMessage('failed');
    }
    if (kind === 'toggle') setState(await readPushState().catch((): PushState => 'off'));
    setBusy(null);
  }

  return (
    <Card title={t('title')} description={t('body')}>
      <div className="space-y-3">
        <FormError>{describeError(failure)}</FormError>
        {state === 'unsupported' && <Notice tone="warn">{t('unsupported')}</Notice>}
        {state === 'untrusted' && <Notice tone="warn">{t('untrusted')}</Notice>}
        {state === 'denied' && <Notice tone="warn">{t('denied')}</Notice>}
        {message === 'testSent' && <Notice tone="ok">{t('testSent')}</Notice>}
        {message === 'failed' && <Notice tone="error">{t('failed')}</Notice>}
        {(state === 'on' || state === 'off') && (
          <div className="flex flex-wrap items-center gap-2">
            <span role="status" className="mr-2 text-sm text-ink">
              {t(state)}
            </span>
            <Button
              variant={state === 'on' ? 'secondary' : 'primary'}
              pending={busy === 'toggle'}
              disabled={busy !== null}
              onClick={() =>
                void run('toggle', () => (state === 'on' ? disablePush() : enablePush(locale)))
              }
            >
              {state === 'on' ? t('disable') : t('enable')}
            </Button>
            {state === 'on' && (
              <Button
                variant="secondary"
                pending={busy === 'test'}
                disabled={busy !== null}
                onClick={() => void run('test', testPush)}
              >
                {t('test')}
              </Button>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

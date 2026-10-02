'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { RevealedCredentials } from '@velnox/shared';
import { apiPost, type ApiFailure } from '@/lib/client-api';
import { useApiError } from '@/lib/use-api-error';
import { Button, FormError } from '@/components/ui/form';
import { Card, Mono } from '@/components/ui/primitives';

/**
 * The break-glass: a VM's passwords, on request.
 *
 * Asking is recorded in the audit trail before the answer is sent. The answer
 * lives in this component's state only — never in the URL, never in storage —
 * and is cleared when the time the API gave runs out, or when the page closes.
 */
export function RevealPanel({
  provisioningId,
  available,
}: {
  provisioningId: string;
  available: boolean;
}) {
  const t = useTranslations();
  const describeError = useApiError();
  const [revealed, setRevealed] = useState<RevealedCredentials | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [pending, setPending] = useState(false);
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    if (!revealed) return;
    const tick = () => {
      const left = Math.max(0, Math.round((Date.parse(revealed.expiresAt) - Date.now()) / 1000));
      setRemaining(left);
      if (left === 0) setRevealed(null);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [revealed]);

  async function reveal() {
    setPending(true);
    setFailure(null);
    const result = await apiPost<RevealedCredentials>(`/provisionings/${provisioningId}/reveal`);
    setPending(false);
    if (!result.ok) return setFailure(result.error);
    setRevealed(result.data);
  }

  return (
    <Card
      title={t('provisioning.credentialsTitle')}
      description={t('provisioning.credentialsDescription')}
    >
      <div className="space-y-3">
        {failure && <FormError>{describeError(failure)}</FormError>}
        {!available && (
          <p className="text-sm text-ink-muted">{t('provisioning.credentialsGone')}</p>
        )}
        {available && !revealed && (
          <Button variant="secondary" onClick={() => void reveal()} pending={pending}>
            {t('provisioning.reveal')}
          </Button>
        )}
        {revealed && (
          <>
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-ink-muted">
                <tr>
                  <th className="py-1 font-medium">{t('provisioning.account')}</th>
                  <th className="py-1 font-medium">{t('provisioning.password')}</th>
                  <th className="py-1 font-medium">{t('provisioning.administrator')}</th>
                </tr>
              </thead>
              <tbody>
                {revealed.accounts.map((account) => (
                  <tr key={account.name} className="border-t border-line/70">
                    <td className="py-1.5">{account.name}</td>
                    <td className="py-1.5">
                      {account.password ? (
                        <Mono>{account.password}</Mono>
                      ) : (
                        <span className="text-ink-muted">
                          {account.name === 'Administrator'
                            ? t('provisioning.switchedOff')
                            : t('provisioning.keyOnly')}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5">
                      {account.administrator ? t('common.yes') : t('common.no')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex items-center gap-3">
              <p className="text-xs text-ink-muted">
                {t('provisioning.revealExpires', { seconds: remaining })}
              </p>
              <Button variant="quiet" onClick={() => setRevealed(null)}>
                {t('provisioning.hide')}
              </Button>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

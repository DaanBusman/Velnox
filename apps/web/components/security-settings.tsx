'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import type { SessionUser } from '@/lib/session-types';
import { apiPost, type ApiFailure } from '@/lib/client-api';
import { useApiError } from '@/lib/use-api-error';
import { Button, CodeInput, Field, FormError } from '@/components/ui/form';
import { Card, Notice, StatusBadge } from '@/components/ui/primitives';
import { MfaEnrolment } from '@/components/mfa-enrolment';
import { RecoveryCodes } from '@/components/recovery-codes';

/**
 * Managing your own second factor.
 *
 * Both destructive actions here — replacing recovery codes and removing the
 * factor — ask for a current code first. Not because the session is untrusted,
 * but because an unattended browser tab should not be enough to strip the
 * account's second factor: the person at the keyboard has to still have the
 * thing they enrolled.
 */
export function SecuritySettings({ user }: { user: SessionUser }) {
  const t = useTranslations();
  const router = useRouter();
  const describeError = useApiError();

  const [mode, setMode] = useState<'idle' | 'enrolling' | 'disabling'>('idle');
  const [code, setCode] = useState('');
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [pending, setPending] = useState(false);
  const [newCodes, setNewCodes] = useState<string[] | null>(null);

  async function regenerate() {
    setPending(true);
    setFailure(null);
    const result = await apiPost<{ recoveryCodes: string[] }>('/auth/mfa/recovery-codes');
    if (result.ok) setNewCodes(result.data.recoveryCodes);
    else setFailure(result.error);
    setPending(false);
  }

  async function disable(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setFailure(null);

    const result = await apiPost('/auth/mfa/disable', { code });
    if (!result.ok) {
      setFailure(result.error);
      setCode('');
      setPending(false);
      return;
    }

    setMode('idle');
    setCode('');
    setPending(false);
    router.refresh();
  }

  if (newCodes) {
    return <RecoveryCodes codes={newCodes} onAcknowledge={() => setNewCodes(null)} />;
  }

  if (mode === 'enrolling') {
    return (
      <MfaEnrolment
        required={user.mfa.required}
        onDone={() => {
          setMode('idle');
          router.refresh();
        }}
      />
    );
  }

  return (
    <div className="space-y-5">
      <Card
        title={t('mfa.sectionTitle')}
        description={t('mfa.sectionDescription')}
        actions={
          user.mfa.enrolled ? (
            <StatusBadge tone="ok">{t('mfa.badgeEnrolled')}</StatusBadge>
          ) : (
            <StatusBadge tone={user.mfa.required ? 'error' : 'warn'}>
              {t('mfa.badgeNotEnrolled')}
            </StatusBadge>
          )
        }
      >
        <div className="space-y-4">
          <FormError>{describeError(failure)}</FormError>

          {!user.mfa.enrolled && (
            <>
              <p className="text-sm text-ink-muted">
                {user.mfa.required ? t('mfa.requiredHere') : t('auth.mfaRecommended')}
              </p>
              <Button type="button" onClick={() => setMode('enrolling')}>
                {t('mfa.enrolAction')}
              </Button>
            </>
          )}

          {user.mfa.enrolled && mode === 'idle' && (
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="secondary" pending={pending} onClick={regenerate}>
                {t('mfa.regenerateRecoveryCodes')}
              </Button>
              <Button type="button" variant="secondary" onClick={() => setMode('disabling')}>
                {t('mfa.disableAction')}
              </Button>
            </div>
          )}

          {user.mfa.enrolled && mode === 'disabling' && (
            <form onSubmit={disable} className="space-y-4">
              {user.mfa.required && (
                <Notice tone="warn" title={t('mfa.disableBlockedTitle')}>
                  {t('mfa.disableBlockedBody')}
                </Notice>
              )}

              <Field label={t('mfa.codeLabel')} hint={t('mfa.disableCodeHint')}>
                {(props) => (
                  <CodeInput
                    {...props}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    autoFocus
                    required
                    disabled={pending}
                  />
                )}
              </Field>

              <div className="flex gap-2">
                <Button type="submit" pending={pending}>
                  {t('mfa.disableAction')}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setMode('idle');
                    setCode('');
                    setFailure(null);
                  }}
                >
                  {t('common.cancel')}
                </Button>
              </div>
            </form>
          )}
        </div>
      </Card>
    </div>
  );
}

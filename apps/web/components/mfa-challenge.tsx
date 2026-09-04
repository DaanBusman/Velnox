'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { apiPost, type ApiFailure } from '@/lib/client-api';
import { useApiError } from '@/lib/use-api-error';
import { Button, CodeInput, Field, FormError, TextInput } from '@/components/ui/form';

/**
 * Answering the second-factor challenge.
 *
 * The recovery path is present but secondary. It has to be reachable — the whole
 * point of a recovery code is the day the enrolled phone is not in the room —
 * and it has to be the harder of the two to reach by accident, because each code
 * spent is one fewer left for the incident after this one.
 */
export function MfaChallenge() {
  const t = useTranslations();
  const router = useRouter();
  const describeError = useApiError();

  const [mode, setMode] = useState<'totp' | 'recovery'>('totp');
  const [code, setCode] = useState('');
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [pending, setPending] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setFailure(null);

    const path = mode === 'totp' ? '/auth/mfa/challenge' : '/auth/mfa/challenge/recovery';
    const result = await apiPost<{ recoveryCodesRemaining?: number }>(path, { code });

    if (!result.ok) {
      setFailure(result.error);
      setCode('');
      setPending(false);
      return;
    }

    if (mode === 'recovery' && typeof result.data.recoveryCodesRemaining === 'number') {
      // Worth seeing before the page changes: someone down to their last code
      // needs to know now, not the next time they are locked out.
      setRemaining(result.data.recoveryCodesRemaining);
    }

    router.replace('/');
    router.refresh();
  }

  function switchMode(next: 'totp' | 'recovery') {
    setMode(next);
    setCode('');
    setFailure(null);
  }

  return (
    <div className="rounded border border-line bg-surface p-6 shadow-[0_1px_2px_rgba(16,21,28,0.04)]">
      <h1 className="text-base font-semibold text-ink">{t('mfa.challengeTitle')}</h1>
      <p className="mt-1 text-sm text-ink-muted">
        {mode === 'totp' ? t('auth.mfaPrompt') : t('auth.mfaRecoveryPrompt')}
      </p>

      <form onSubmit={submit} className="mt-5 space-y-4">
        <FormError>{describeError(failure)}</FormError>

        {remaining !== null && (
          <p className="text-xs text-warn">{t('mfa.recoveryRemaining', { count: remaining })}</p>
        )}

        <Field label={mode === 'totp' ? t('mfa.codeLabel') : t('mfa.recoveryCodeLabel')}>
          {(props) =>
            mode === 'totp' ? (
              <CodeInput
                {...props}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoFocus
                required
                disabled={pending}
              />
            ) : (
              <TextInput
                {...props}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="off"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                className="font-mono"
                autoFocus
                required
                disabled={pending}
              />
            )
          }
        </Field>

        <Button type="submit" pending={pending} className="w-full">
          {t('mfa.verify')}
        </Button>
      </form>

      <div className="mt-4 text-center">
        <Button
          type="button"
          variant="quiet"
          onClick={() => switchMode(mode === 'totp' ? 'recovery' : 'totp')}
          disabled={pending}
        >
          {mode === 'totp' ? t('mfa.useRecoveryCode') : t('mfa.useAuthenticator')}
        </Button>
      </div>
    </div>
  );
}

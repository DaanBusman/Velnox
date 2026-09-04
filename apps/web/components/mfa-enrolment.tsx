'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { apiPost, type ApiFailure } from '@/lib/client-api';
import { useApiError } from '@/lib/use-api-error';
import { Button, CodeInput, Field, FormError } from '@/components/ui/form';
import { Notice } from '@/components/ui/primitives';
import { QrCode } from '@/components/qr-code';
import { RecoveryCodes } from '@/components/recovery-codes';

interface EnrolmentOffer {
  secret: string;
  uri: string;
}

/**
 * Enrolling an authenticator app.
 *
 * Three steps, in this order for a reason: the offer is fetched, the user proves
 * a working code, and only then do recovery codes appear. Issuing recovery codes
 * before the factor is proven would hand out a way back in for a factor that may
 * never work — and showing them first is how people end up enrolled in something
 * they cannot actually use.
 */
export function MfaEnrolment({
  /** True when a policy requires this and the user cannot skip it. */
  required,
  onDone,
}: {
  required: boolean;
  onDone?: () => void;
}) {
  const t = useTranslations();
  const router = useRouter();
  const describeError = useApiError();

  const [offer, setOffer] = useState<EnrolmentOffer | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [pending, setPending] = useState(true);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const result = await apiPost<EnrolmentOffer>('/auth/mfa/enrol');
      if (cancelled) return;

      if (result.ok) setOffer(result.data);
      else setFailure(result.error);
      setPending(false);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  async function confirm(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setFailure(null);

    const result = await apiPost<{ recoveryCodes: string[] }>('/auth/mfa/enrol/confirm', { code });

    if (!result.ok) {
      setFailure(result.error);
      setCode('');
      setPending(false);
      return;
    }

    setRecoveryCodes(result.data.recoveryCodes);
    setPending(false);
  }

  if (recoveryCodes) {
    return (
      <RecoveryCodes
        codes={recoveryCodes}
        onAcknowledge={() => {
          router.refresh();
          onDone?.();
        }}
      />
    );
  }

  return (
    <div className="rounded border border-line bg-surface p-6 shadow-[0_1px_2px_rgba(16,21,28,0.04)]">
      <h1 className="text-base font-semibold text-ink">{t('mfa.enrolTitle')}</h1>
      <p className="mt-1 text-sm text-ink-muted">
        {required ? t('mfa.enrolRequiredBody') : t('mfa.enrolOptionalBody')}
      </p>

      <div className="mt-5 space-y-4">
        <FormError>{describeError(failure)}</FormError>

        {offer && (
          <>
            <div className="flex justify-center">
              <QrCode value={offer.uri} />
            </div>

            <div>
              <p className="text-xs text-ink-muted">{t('mfa.manualEntry')}</p>
              <p className="mt-1 select-all break-all rounded bg-surface-2 px-2 py-1.5 font-mono text-sm text-ink">
                {offer.secret}
              </p>
            </div>

            <form onSubmit={confirm} className="space-y-4">
              <Field label={t('mfa.codeLabel')} hint={t('mfa.enrolCodeHint')}>
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

              <Button type="submit" pending={pending} className="w-full">
                {t('mfa.confirmEnrolment')}
              </Button>
            </form>
          </>
        )}

        {!offer && !pending && (
          <Notice tone="error" title={t('mfa.enrolUnavailableTitle')}>
            {t('mfa.enrolUnavailableBody')}
          </Notice>
        )}
      </div>
    </div>
  );
}

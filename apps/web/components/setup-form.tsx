'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { apiPost, type ApiFailure } from '@/lib/client-api';
import { useApiError } from '@/lib/use-api-error';
import { Button, Field, FormError, TextInput } from '@/components/ui/form';
import { Notice } from '@/components/ui/primitives';

/** Matches PASSWORD_MIN_LENGTH in @velnox/crypto, which the API enforces. */
const PASSWORD_MIN_LENGTH = 12;

/**
 * First run.
 *
 * Creates the MSP root tenant, the system roles and the first administrator in
 * one transaction, then closes permanently. There is no default account and no
 * default password at any point — the first credential that exists is the one
 * typed here.
 *
 * The strength check below is a courtesy that gives feedback while typing. The
 * API enforces the real rule and will refuse a weak password regardless of what
 * this component thinks, which is the only reason it is safe for it to be this
 * simple.
 */
export function SetupForm({ product }: { product: string }) {
  const t = useTranslations();
  const router = useRouter();
  const describeError = useApiError();

  const [organisationName, setOrganisationName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [pending, setPending] = useState(false);

  const tooShort = password.length > 0 && password.length < PASSWORD_MIN_LENGTH;
  const mismatch = confirmation.length > 0 && confirmation !== password;

  const fieldErrors = useMemo(() => {
    const map = new Map<string, string>();
    for (const detail of failure?.details ?? []) map.set(detail.path, detail.message);
    return map;
  }, [failure]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (mismatch || tooShort) return;

    setPending(true);
    setFailure(null);

    const result = await apiPost('/setup/initialize', {
      organisationName,
      displayName,
      email,
      password,
    });

    if (!result.ok) {
      setFailure(result.error);
      setPending(false);
      return;
    }

    // Initialisation does not sign anyone in — the first thing the new
    // administrator does is prove the password they just chose.
    router.replace('/login');
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="rounded border border-line bg-surface p-6 shadow-[0_1px_2px_rgba(16,21,28,0.04)]">
        <h1 className="text-base font-semibold text-ink">{t('setup.title', { product })}</h1>
        <p className="mt-1 text-sm text-ink-muted">{t('setup.subtitle')}</p>

        <form onSubmit={submit} className="mt-5 space-y-4">
          <FormError>{describeError(failure)}</FormError>

          <Field
            label={t('setup.organisationName')}
            hint={t('setup.organisationNameHint')}
            error={fieldErrors.get('organisationName')}
          >
            {(props) => (
              <TextInput
                {...props}
                value={organisationName}
                onChange={(e) => setOrganisationName(e.target.value)}
                autoComplete="organization"
                autoFocus
                required
                minLength={2}
                disabled={pending}
              />
            )}
          </Field>

          <Field label={t('setup.name')} error={fieldErrors.get('displayName')}>
            {(props) => (
              <TextInput
                {...props}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                autoComplete="name"
                required
                minLength={2}
                disabled={pending}
              />
            )}
          </Field>

          <Field label={t('setup.email')} error={fieldErrors.get('email')}>
            {(props) => (
              <TextInput
                {...props}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                required
                disabled={pending}
              />
            )}
          </Field>

          <Field
            label={t('setup.password')}
            hint={t('setup.passwordHint', { min: PASSWORD_MIN_LENGTH })}
            error={tooShort ? t('setup.passwordWeak') : fieldErrors.get('password')}
          >
            {(props) => (
              <TextInput
                {...props}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                required
                minLength={PASSWORD_MIN_LENGTH}
                disabled={pending}
              />
            )}
          </Field>

          <Field
            label={t('setup.passwordConfirm')}
            error={mismatch ? t('setup.passwordMismatch') : undefined}
          >
            {(props) => (
              <TextInput
                {...props}
                type="password"
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                autoComplete="new-password"
                required
                disabled={pending}
              />
            )}
          </Field>

          <Button type="submit" pending={pending} disabled={mismatch || tooShort} className="w-full">
            {t('setup.createAccount')}
          </Button>
        </form>
      </div>

      {/*
        Placed after the form rather than before it. Someone setting up a server
        reads the thing next to the button they are about to press, and losing
        the master key is the one mistake here that cannot be undone later.
      */}
      <Notice tone="warn" title={t('setup.masterKeyWarningTitle')}>
        {t('setup.masterKeyWarning')}
      </Notice>
    </div>
  );
}

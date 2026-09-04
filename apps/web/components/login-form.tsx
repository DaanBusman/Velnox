'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { apiPost, type ApiFailure } from '@/lib/client-api';
import { useApiError } from '@/lib/use-api-error';
import { Button, Field, FormError, TextInput } from '@/components/ui/form';

interface LoginResponse {
  status: 'authenticated' | 'mfa_required' | 'mfa_enrolment_required';
}

/**
 * Sign in.
 *
 * The request goes from the browser to the API so the browser receives the
 * `Set-Cookie` headers directly and the session cookie stays `HttpOnly`.
 *
 * Where the user lands next is decided by the API's answer, not by this form:
 * a session may be complete, may owe a code, or may owe an enrolment it has
 * never done. Guessing here would mean a redirect loop the first time a policy
 * changes.
 */
export function LoginForm({ ssoEnabled }: { ssoEnabled: boolean }) {
  const t = useTranslations();
  const router = useRouter();
  const describeError = useApiError();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setFailure(null);

    const result = await apiPost<LoginResponse>('/auth/login', { email, password });

    if (!result.ok) {
      setFailure(result.error);
      setPending(false);
      return;
    }

    // Stay pending through the navigation: re-enabling the button here would
    // invite a second submission against a session that already exists.
    router.replace(result.data.status === 'authenticated' ? '/' : '/mfa');
    router.refresh();
  }

  return (
    <div className="rounded border border-line bg-surface p-6 shadow-[0_1px_2px_rgba(16,21,28,0.04)]">
      <h1 className="text-base font-semibold text-ink">{t('auth.signIn')}</h1>

      <form onSubmit={submit} className="mt-5 space-y-4">
        <FormError>{describeError(failure)}</FormError>

        <Field label={t('auth.email')}>
          {(props) => (
            <TextInput
              {...props}
              type="email"
              name="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              autoFocus
              required
              disabled={pending}
            />
          )}
        </Field>

        <Field label={t('auth.password')}>
          {(props) => (
            <TextInput
              {...props}
              type="password"
              name="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              disabled={pending}
            />
          )}
        </Field>

        <Button type="submit" pending={pending} className="w-full">
          {t('auth.signIn')}
        </Button>
      </form>

      {ssoEnabled && (
        <>
          <div className="my-5 flex items-center gap-3 text-xs text-ink-muted">
            <span className="h-px flex-1 bg-line" />
            {t('auth.or')}
            <span className="h-px flex-1 bg-line" />
          </div>

          <a
            href="/api/v1/auth/oidc/start"
            className="inline-flex h-9 w-full items-center justify-center rounded border border-line bg-surface text-sm font-medium text-ink hover:bg-surface-2"
          >
            {t('auth.signInWithMicrosoft')}
          </a>
        </>
      )}
    </div>
  );
}

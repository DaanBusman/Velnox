'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { IdentityProviderView } from '@/lib/session-types';
import { apiPut, apiPost, type ApiFailure } from '@/lib/client-api';
import { useApiError } from '@/lib/use-api-error';
import { Button, Field, FormError, TextInput } from '@/components/ui/form';
import { Notice } from '@/components/ui/primitives';
import { CopyField } from '@/components/copy-field';

interface TestResult {
  ok: boolean;
  reason?: string;
  detail?: string;
  warnings: string[];
}

/**
 * Connecting Entra ID, one step at a time.
 *
 * Setting this up means alternating between two browser tabs and copying four
 * values in the right direction — two out of Velnox into Entra, two back again.
 * A single form of five inputs does not tell anyone that, and the usual result
 * is a redirect URI that differs by one character and an error from Microsoft
 * that explains nothing.
 *
 * So each step covers exactly one thing the operator does in the other tab, and
 * the values Velnox knows are shown as something to copy rather than something
 * to retype.
 */

type StepId = 'intro' | 'register' | 'identifiers' | 'secret' | 'restrict' | 'test';

const STEPS: StepId[] = ['intro', 'register', 'identifiers', 'secret', 'restrict', 'test'];

export function SsoWizard({
  provider,
  onCancel,
}: {
  provider: IdentityProviderView;
  onCancel: () => void;
}) {
  const t = useTranslations();
  const router = useRouter();
  const describeError = useApiError();

  const [step, setStep] = useState<StepId>('intro');
  const [tenantId, setTenantId] = useState('');
  const [clientId, setClientId] = useState(provider.clientId ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [domains, setDomains] = useState(provider.allowedEmailDomains.join(', '));
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [pending, setPending] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const index = STEPS.indexOf(step);

  /*
   * The discovery URL is assembled rather than asked for.
   *
   * It is the one value that is entirely mechanical — the tenant id in a fixed
   * Microsoft URL — and asking an operator to paste a long URL they have to
   * construct is asking for a typo in the only field where a typo produces an
   * unhelpful error.
   */
  const discoveryUrl = tenantId.trim()
    ? `https://login.microsoftonline.com/${tenantId.trim()}/v2.0/.well-known/openid-configuration`
    : '';

  function goTo(next: StepId) {
    setStep(next);
    setFailure(null);
  }

  const back = () => index > 0 && goTo(STEPS[index - 1]!);
  const next = () => index < STEPS.length - 1 && goTo(STEPS[index + 1]!);

  /** Saves what has been entered so far, then runs the connection test. */
  async function saveAndTest() {
    setPending(true);
    setFailure(null);
    setTestResult(null);

    const saved = await apiPut<IdentityProviderView>('/identity-providers/oidc', {
      discoveryUrl: discoveryUrl || null,
      clientId: clientId.trim() || null,
      ...(clientSecret ? { clientSecret } : {}),
      allowedEmailDomains: domains
        .split(',')
        .map((domain) => domain.trim())
        .filter(Boolean),
    });

    if (!saved.ok) {
      setFailure(saved.error);
      setPending(false);
      return;
    }

    const tested = await apiPost<TestResult>('/identity-providers/oidc/test');
    if (tested.ok) setTestResult(tested.data);
    else setFailure(tested.error);

    setPending(false);
    router.refresh();
  }

  return (
    <div className="rounded border border-line bg-surface p-6 shadow-[0_1px_2px_rgba(16,21,28,0.04)]">
      <ol className="mb-5 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {STEPS.map((id, position) => (
          <li
            key={id}
            aria-current={id === step ? 'step' : undefined}
            className={
              position === index
                ? 'font-medium text-ink'
                : position < index
                  ? 'text-ink-muted'
                  : 'text-ink-muted/60'
            }
          >
            {position + 1}. {t(`sso.wizard.${id}.short`)}
          </li>
        ))}
      </ol>

      <h2 className="text-base font-semibold text-ink">{t(`sso.wizard.${step}.title`)}</h2>
      <p className="mt-1 text-sm text-ink-muted">{t(`sso.wizard.${step}.body`)}</p>

      <div className="mt-5 space-y-4">
        <FormError>{describeError(failure)}</FormError>

        {step === 'intro' && (
          <ol className="list-decimal space-y-1.5 pl-5 text-sm text-ink">
            <li>{t('sso.wizard.intro.need1')}</li>
            <li>{t('sso.wizard.intro.need2')}</li>
            <li>{t('sso.wizard.intro.need3')}</li>
          </ol>
        )}

        {step === 'register' && (
          <div className="space-y-4">
            <CopyField label={t('sso.wizard.register.nameLabel')} value={provider.suggestedAppName} />
            <CopyField
              label={t('sso.wizard.register.redirectLabel')}
              value={provider.redirectUri}
              hint={t('sso.wizard.register.redirectHint')}
            />
            <Notice tone="neutral">{t('sso.wizard.register.accountTypes')}</Notice>
          </div>
        )}

        {step === 'identifiers' && (
          <div className="space-y-4">
            <Field label={t('sso.wizard.identifiers.tenantLabel')} hint={t('sso.wizard.identifiers.tenantHint')}>
              {(props) => (
                <TextInput
                  {...props}
                  value={tenantId}
                  onChange={(e) => setTenantId(e.target.value)}
                  placeholder="00000000-0000-0000-0000-000000000000"
                  autoComplete="off"
                  spellCheck={false}
                />
              )}
            </Field>

            <Field label={t('sso.wizard.identifiers.clientLabel')} hint={t('sso.wizard.identifiers.clientHint')}>
              {(props) => (
                <TextInput
                  {...props}
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder="00000000-0000-0000-0000-000000000000"
                  autoComplete="off"
                  spellCheck={false}
                />
              )}
            </Field>

            {discoveryUrl && (
              <div>
                <p className="text-xs text-ink-muted">{t('sso.wizard.identifiers.derived')}</p>
                <p className="mt-1 break-all rounded bg-surface-2 px-2 py-1.5 font-mono text-xs text-ink">
                  {discoveryUrl}
                </p>
              </div>
            )}
          </div>
        )}

        {step === 'secret' && (
          <Field
            label={t('sso.clientSecret')}
            hint={
              provider.clientSecretSet
                ? t('sso.wizard.secret.alreadyStored')
                : t('sso.wizard.secret.hint')
            }
          >
            {(props) => (
              <TextInput
                {...props}
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                autoComplete="new-password"
                placeholder={provider.clientSecretSet ? '••••••••' : ''}
              />
            )}
          </Field>
        )}

        {step === 'restrict' && (
          <Field label={t('sso.allowedDomains')} hint={t('sso.allowedDomainsHint')}>
            {(props) => (
              <TextInput
                {...props}
                value={domains}
                onChange={(e) => setDomains(e.target.value)}
                placeholder="example.com, example.nl"
              />
            )}
          </Field>
        )}

        {step === 'test' && (
          <div className="space-y-4">
            <dl className="rounded border border-line bg-surface-2 px-3 py-2 text-xs">
              <div className="flex justify-between gap-4 py-0.5">
                <dt className="text-ink-muted">{t('sso.wizard.identifiers.clientLabel')}</dt>
                <dd className="truncate font-mono text-ink">{clientId || '—'}</dd>
              </div>
              <div className="flex justify-between gap-4 py-0.5">
                <dt className="text-ink-muted">{t('sso.clientSecret')}</dt>
                <dd className="text-ink">
                  {clientSecret
                    ? t('sso.wizard.test.secretEntered')
                    : provider.clientSecretSet
                      ? t('sso.wizard.test.secretKept')
                      : t('sso.wizard.test.secretMissing')}
                </dd>
              </div>
              <div className="flex justify-between gap-4 py-0.5">
                <dt className="text-ink-muted">{t('sso.allowedDomains')}</dt>
                <dd className="truncate text-ink">{domains.trim() || t('sso.wizard.test.anyDomain')}</dd>
              </div>
            </dl>

            {testResult && (
              <Notice tone={testResult.ok ? 'ok' : 'error'}>
                {testResult.ok
                  ? t('sso.testOk')
                  : t('sso.testFailedDetail', {
                      reason: testResult.reason ?? 'generic',
                      detail: testResult.detail ?? '—',
                    })}
              </Notice>
            )}

            <Notice tone="neutral" title={t('sso.notAvailableTitle')}>
              {t('sso.notAvailableBody')}
            </Notice>
          </div>
        )}
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-line pt-4">
        {index > 0 ? (
          <Button type="button" variant="secondary" onClick={back} disabled={pending}>
            {t('sso.wizard.back')}
          </Button>
        ) : (
          <Button type="button" variant="secondary" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        )}

        {step !== 'test' ? (
          <Button
            type="button"
            onClick={next}
            // Only the identifiers step has a value the next steps depend on.
            disabled={step === 'identifiers' && !(tenantId.trim() && clientId.trim())}
          >
            {t('sso.wizard.next')}
          </Button>
        ) : (
          <Button type="button" onClick={saveAndTest} pending={pending}>
            {t('sso.wizard.saveAndTest')}
          </Button>
        )}

        {step === 'test' && testResult?.ok && (
          <Button type="button" variant="secondary" onClick={onCancel}>
            {t('sso.wizard.done')}
          </Button>
        )}
      </div>
    </div>
  );
}

'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import type { IdentityProviderView } from '@/lib/session-types';
import { apiPost, type ApiFailure } from '@/lib/client-api';
import { useApiError } from '@/lib/use-api-error';
import { Button, FormError } from '@/components/ui/form';
import { Card, KeyValue, Notice, StatusBadge } from '@/components/ui/primitives';
import { CopyField } from '@/components/copy-field';
import { SsoWizard } from '@/components/sso-wizard';

interface TestResult {
  ok: boolean;
  reason?: string;
  detail?: string;
  warnings: string[];
}

/**
 * Microsoft Entra ID.
 *
 * An unconfigured installation goes straight into the wizard, because there is
 * nothing to look at and the job ahead involves another browser tab. A
 * configured one shows what is stored and what the last check actually
 * observed — "checked at 14:02 and the provider answered" is a fact, whereas
 * "configured" only says a form was filled in.
 *
 * The client secret is write-only throughout. No endpoint returns it, so there
 * is nothing to display and nothing to accidentally put in a screenshot.
 */
export function SsoSettings({ initial }: { initial: IdentityProviderView }) {
  const t = useTranslations();
  const format = useFormatter();
  const router = useRouter();
  const describeError = useApiError();

  const [wizardOpen, setWizardOpen] = useState(!initial.configured);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  async function test() {
    setTesting(true);
    setFailure(null);
    setTestResult(null);

    const result = await apiPost<TestResult>('/identity-providers/oidc/test');
    if (result.ok) setTestResult(result.data);
    else setFailure(result.error);

    setTesting(false);
    router.refresh();
  }

  if (wizardOpen) {
    return (
      <div className="space-y-5">
        <SsoWizard
          provider={initial}
          onCancel={() => {
            setWizardOpen(false);
            router.refresh();
          }}
        />
        <Notice tone="warn" title={t('sso.breakGlassTitle')}>
          {t('sso.breakGlassBody')}
        </Notice>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Notice tone="neutral" title={t('sso.notAvailableTitle')}>
        {t('sso.notAvailableBody')}
      </Notice>

      <Card
        title={initial.name}
        description={t('sso.cardDescription')}
        actions={
          initial.lastTestOk === null ? (
            <StatusBadge tone="unknown">{t('sso.neverTested')}</StatusBadge>
          ) : (
            <StatusBadge tone={initial.lastTestOk ? 'ok' : 'error'}>
              {initial.lastTestOk ? t('sso.testPassed') : t('sso.testFailed')}
            </StatusBadge>
          )
        }
      >
        <div className="space-y-4">
          <FormError>{describeError(failure)}</FormError>

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

          <dl>
            <KeyValue label={t('sso.clientId')}>
              <span className="font-mono text-xs">{initial.clientId ?? '—'}</span>
            </KeyValue>
            <KeyValue label={t('sso.issuer')}>
              <span className="break-all font-mono text-xs">{initial.issuer ?? '—'}</span>
            </KeyValue>
            <KeyValue label={t('sso.clientSecret')}>
              {initial.clientSecretSet ? t('sso.secretStored') : t('sso.secretMissing')}
            </KeyValue>
            <KeyValue label={t('sso.allowedDomains')}>
              {initial.allowedEmailDomains.length > 0
                ? initial.allowedEmailDomains.join(', ')
                : t('sso.wizard.test.anyDomain')}
            </KeyValue>
            <KeyValue label={t('sso.lastCheck')}>
              {initial.lastTestedAt
                ? `${format.dateTime(new Date(initial.lastTestedAt), {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })} — ${initial.lastTestMessage ?? '—'}`
                : t('sso.neverTested')}
            </KeyValue>
          </dl>

          {/* Kept visible after setup: the app registration in Entra has to keep
              matching this, and it is the value people come back to check. */}
          <CopyField
            label={t('sso.wizard.register.redirectLabel')}
            value={initial.redirectUri}
            hint={t('sso.wizard.register.redirectHint')}
          />

          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" pending={testing} onClick={test}>
              {t('sso.testConnection')}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setWizardOpen(true)}>
              {t('sso.reconfigure')}
            </Button>
          </div>
        </div>
      </Card>

      <Notice tone="warn" title={t('sso.breakGlassTitle')}>
        {t('sso.breakGlassBody')}
      </Notice>
    </div>
  );
}

'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import type { IdentityProviderView } from '@/lib/session-types';
import { apiPut, apiPost, type ApiFailure } from '@/lib/client-api';
import { useApiError } from '@/lib/use-api-error';
import { Button, Field, FormError, TextInput } from '@/components/ui/form';
import { Card, Notice, StatusBadge } from '@/components/ui/primitives';

interface TestResult {
  ok: boolean;
  reason?: string;
  detail?: string;
  warnings: string[];
}

/**
 * Microsoft Entra ID configuration.
 *
 * Two honesty rules shape this screen.
 *
 * The client secret is write-only. The field shows whether one is stored, never
 * what it is, because the API has no endpoint that would return it — and a
 * masked field that round-trips a real value is how secrets end up in browser
 * memory and in screenshots.
 *
 * The test result is a record of what happened, not a summary of what was
 * typed. "Configured" means a form was filled in; "checked at 14:02 and the
 * provider answered" is the thing an administrator actually needs.
 */
export function SsoSettings({ initial }: { initial: IdentityProviderView }) {
  const t = useTranslations();
  const router = useRouter();
  const describeError = useApiError();

  const [discoveryUrl, setDiscoveryUrl] = useState(initial.discoveryUrl ?? '');
  const [clientId, setClientId] = useState(initial.clientId ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [domains, setDomains] = useState(initial.allowedEmailDomains.join(', '));
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFailure(null);
    setTestResult(null);

    const result = await apiPut<IdentityProviderView>('/identity-providers/oidc', {
      discoveryUrl: discoveryUrl.trim() || null,
      clientId: clientId.trim() || null,
      // Undefined leaves the stored secret alone; an empty box is not an
      // instruction to delete it.
      ...(clientSecret ? { clientSecret } : {}),
      allowedEmailDomains: domains
        .split(',')
        .map((domain) => domain.trim())
        .filter(Boolean),
    });

    if (!result.ok) {
      setFailure(result.error);
      setSaving(false);
      return;
    }

    setClientSecret('');
    setSaving(false);
    router.refresh();
  }

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
        <form onSubmit={save} className="space-y-4">
          <FormError>{describeError(failure)}</FormError>

          {testResult && (
            <Notice tone={testResult.ok ? 'ok' : 'error'}>
              {testResult.ok
                ? t('sso.testOk')
                : t('sso.testFailedDetail', {
                    reason: testResult.reason ?? 'generic',
                    detail: testResult.detail ?? '—',
                  })}
              {testResult.warnings.length > 0 && (
                <p className="mt-1">{testResult.warnings.join(', ')}</p>
              )}
            </Notice>
          )}

          <Field label={t('sso.discoveryUrl')} hint={t('sso.discoveryUrlHint')}>
            {(props) => (
              <TextInput
                {...props}
                type="url"
                value={discoveryUrl}
                onChange={(e) => setDiscoveryUrl(e.target.value)}
                placeholder="https://login.microsoftonline.com/<tenant>/v2.0/.well-known/openid-configuration"
                disabled={saving}
              />
            )}
          </Field>

          <Field label={t('sso.clientId')}>
            {(props) => (
              <TextInput
                {...props}
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                autoComplete="off"
                disabled={saving}
              />
            )}
          </Field>

          <Field
            label={t('sso.clientSecret')}
            hint={initial.clientSecretSet ? t('sso.clientSecretStored') : t('sso.clientSecretHint')}
          >
            {(props) => (
              <TextInput
                {...props}
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                autoComplete="new-password"
                placeholder={initial.clientSecretSet ? '••••••••' : ''}
                disabled={saving}
              />
            )}
          </Field>

          <Field label={t('sso.allowedDomains')} hint={t('sso.allowedDomainsHint')}>
            {(props) => (
              <TextInput
                {...props}
                value={domains}
                onChange={(e) => setDomains(e.target.value)}
                placeholder="example.com, example.nl"
                disabled={saving}
              />
            )}
          </Field>

          <div className="flex flex-wrap gap-2">
            <Button type="submit" pending={saving}>
              {t('common.save')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              pending={testing}
              disabled={!initial.discoveryUrl}
              onClick={test}
            >
              {t('sso.testConnection')}
            </Button>
          </div>

          {initial.lastTestedAt && (
            <p className="text-xs text-ink-muted">
              {t('sso.lastTested', {
                time: new Date(initial.lastTestedAt).toLocaleString(),
                message: initial.lastTestMessage ?? '—',
              })}
            </p>
          )}
        </form>
      </Card>

      <Notice tone="warn" title={t('sso.breakGlassTitle')}>
        {t('sso.breakGlassBody')}
      </Notice>
    </div>
  );
}

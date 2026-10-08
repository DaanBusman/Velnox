'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { TlsChangeRequest, TlsChangeResponse, TlsStatusResponse } from '@velnox/shared';
import { apiPut, type ApiFailure } from '@/lib/client-api';
import { useApiError } from '@/lib/use-api-error';
import { Button, Field, FormError, TextInput } from '@/components/ui/form';
import { Card, Notice } from '@/components/ui/primitives';

type Choice = TlsChangeRequest['mode'];

const area =
  'block min-h-28 w-full rounded border border-line bg-surface-2 px-2.5 py-2 font-mono text-xs text-ink focus:border-accent focus:outline-none';

/**
 * Changing the certificate from Server management (Phase 5C, ADR-045).
 *
 * The API writes Caddy's files and reloads it through its admin socket; Caddy
 * refuses a configuration it cannot serve and keeps the old one, and the
 * certificate served afterwards is read back over a real handshake. An
 * uploaded key goes to the secret store and is never shown again.
 */
export function CertificateChange({
  status,
  onChanged,
}: {
  status: TlsStatusResponse;
  onChanged: (status: TlsStatusResponse) => void;
}) {
  const t = useTranslations();
  const describeError = useApiError();
  const [choice, setChoice] = useState<Choice>(
    status.managedBy === 'installer'
      ? 'installer'
      : status.mode === 'acme'
        ? 'acme'
        : status.mode === 'certificate'
          ? 'certificate'
          : 'internal',
  );
  const [email, setEmail] = useState(status.acmeAccount ?? '');
  const [otherCa, setOtherCa] = useState(Boolean(status.acmeDirectory));
  const [directory, setDirectory] = useState(status.acmeDirectory ?? '');
  const [caRoot, setCaRoot] = useState('');
  const [certificate, setCertificate] = useState('');
  const [key, setKey] = useState('');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [result, setResult] = useState<TlsChangeResponse | null>(null);

  const isIp = /^[\d.]+$|:/.test(status.siteAddress);

  const load = (set: (text: string) => void) => (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void file.text().then(set);
  };

  async function apply() {
    setPending(true);
    setFailure(null);
    setResult(null);
    const request: TlsChangeRequest =
      choice === 'acme'
        ? {
            mode: 'acme',
            email: email.trim(),
            directory: otherCa && directory.trim() ? directory.trim() : null,
            caRoot: otherCa && caRoot.trim() ? caRoot : null,
          }
        : choice === 'certificate'
          ? { mode: 'certificate', certificate, key }
          : { mode: choice };
    const response = await apiPut<TlsChangeResponse>('/system/tls', request);
    setPending(false);
    if (!response.ok) return setFailure(response.error);
    // The key is not kept in the page once it is stored.
    setKey('');
    setResult(response.data);
    onChanged(response.data.status);
  }

  const options: { value: Choice; label: string; hint: string; disabled?: boolean }[] = [
    { value: 'installer', label: t('tls.choice.installer'), hint: t('tls.choiceHint.installer') },
    { value: 'internal', label: t('tls.choice.internal'), hint: t('tls.choiceHint.internal') },
    {
      value: 'acme',
      label: t('tls.choice.acme'),
      hint: isIp ? t('tls.acmeNeedsHostname') : t('tls.choiceHint.acme'),
      disabled: isIp,
    },
    {
      value: 'certificate',
      label: t('tls.choice.certificate'),
      hint: t('tls.choiceHint.certificate'),
    },
  ];

  const ready =
    choice === 'acme'
      ? email.includes('@') && (!otherCa || directory.startsWith('https://'))
      : choice === 'certificate'
        ? certificate.includes('BEGIN CERTIFICATE') && key.includes('PRIVATE KEY')
        : true;

  return (
    <Card title={t('tls.changeTitle')} description={t('tls.changeInterfaceBody')}>
      <div className="space-y-4">
        {failure && <FormError>{describeError(failure)}</FormError>}
        {result && (
          <Notice
            tone={result.verified ? 'ok' : 'warn'}
            title={result.verified ? t('tls.appliedVerified') : t('tls.appliedNotYet')}
          >
            {result.verified
              ? t('tls.appliedVerifiedBody')
              : choice === 'acme'
                ? t('tls.appliedAcmePending')
                : t('tls.appliedNotVerifiedBody')}
            {result.warnings.map((warning) => (
              <span key={warning} className="mt-1 block">
                {t(`tls.warning.${warning.replace('tls.warning_', '')}`)}
              </span>
            ))}
          </Notice>
        )}

        <fieldset className="space-y-2">
          {options.map((option) => (
            <label
              key={option.value}
              className={`flex items-start gap-2 rounded border p-2.5 text-sm ${
                choice === option.value ? 'border-accent bg-surface-2' : 'border-line'
              } ${option.disabled ? 'opacity-60' : ''}`}
            >
              <input
                type="radio"
                name="tls-choice"
                className="mt-1"
                checked={choice === option.value}
                disabled={option.disabled}
                onChange={() => setChoice(option.value)}
              />
              <span>
                <span className="block font-medium text-ink">{option.label}</span>
                <span className="block text-xs text-ink-muted">{option.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {choice === 'acme' && (
          <div className="space-y-3">
            <Field label={t('tls.acmeEmail')} hint={t('tls.acmeEmailHint')}>
              {(props) => (
                <TextInput
                  {...props}
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              )}
            </Field>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={otherCa}
                onChange={(e) => setOtherCa(e.target.checked)}
              />
              {t('tls.otherAcme')}
            </label>
            {otherCa && (
              <>
                <Field label={t('tls.acmeDirectory')} hint={t('tls.acmeDirectoryHint')}>
                  {(props) => (
                    <TextInput
                      {...props}
                      value={directory}
                      placeholder="https://acme.example.com/directory"
                      onChange={(e) => setDirectory(e.target.value)}
                    />
                  )}
                </Field>
                <Field label={t('tls.acmeRoot')} hint={t('tls.acmeRootHint')}>
                  {(props) => (
                    <textarea
                      {...props}
                      className={area}
                      value={caRoot}
                      onChange={(e) => setCaRoot(e.target.value)}
                    />
                  )}
                </Field>
              </>
            )}
          </div>
        )}

        {choice === 'certificate' && (
          <div className="space-y-3">
            <Field label={t('tls.certificateField')} hint={t('tls.certificateFieldHint')}>
              {(props) => (
                <textarea
                  {...props}
                  className={area}
                  value={certificate}
                  placeholder="-----BEGIN CERTIFICATE-----"
                  onChange={(e) => setCertificate(e.target.value)}
                />
              )}
            </Field>
            <input type="file" accept=".pem,.crt,.cer" onChange={load(setCertificate)} />
            <Field label={t('tls.keyField')} hint={t('tls.keyFieldHint')}>
              {(props) => (
                <textarea
                  {...props}
                  className={area}
                  value={key}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="-----BEGIN PRIVATE KEY-----"
                  onChange={(e) => setKey(e.target.value)}
                />
              )}
            </Field>
            <input type="file" accept=".pem,.key" onChange={load(setKey)} />
          </div>
        )}

        <Notice tone="neutral">{t('tls.breakGlass')}</Notice>

        <Button onClick={() => void apply()} disabled={!ready || pending} pending={pending}>
          {t('tls.apply')}
        </Button>
      </div>
    </Card>
  );
}

'use client';

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import type { CertificateReport, SiteSummary, TenantSummary } from '@/lib/session-types';
import { apiPost, type ApiFailure } from '@/lib/client-api';
import { useApiError } from '@/lib/use-api-error';
import { Button, Field, FormError, TextInput } from '@/components/ui/form';
import { Card, Notice } from '@/components/ui/primitives';
import { Fingerprint } from './primitives';

/**
 * Adding a cluster, in three steps that cannot be collapsed into one.
 *
 * 1. **Where is it.** Velnox connects and reads the certificate. Nothing is sent
 *    — no token, no password — because at this point nobody has said this is the
 *    right machine.
 * 2. **Is this the right machine.** The fingerprint is shown and the operator
 *    confirms it against `pvenode cert info` on the node. This is the whole
 *    security of the connection: from here on, that one certificate is what
 *    Velnox will talk to and nothing else.
 * 3. **How to sign in.** Only now does a credential exist in the form, and it
 *    travels only to the certificate just confirmed.
 *
 * The middle step is the one that is tempting to skip, and skipping it means
 * sending an API token that can reconfigure a hypervisor to whatever answered on
 * port 8006.
 */
export function AddCluster({
  tenants,
  sites,
  onDone,
  onCancel,
}: {
  tenants: TenantSummary[];
  sites: SiteSummary[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations();
  const describeError = useApiError();

  const [host, setHost] = useState('');
  const [port, setPort] = useState('8006');
  const [certificate, setCertificate] = useState<CertificateReport | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  const [tenantId, setTenantId] = useState(tenants[0]?.id ?? '');
  const [siteId, setSiteId] = useState('');
  const [name, setName] = useState('');
  const [authKind, setAuthKind] = useState<'API_TOKEN' | 'TICKET'>('API_TOKEN');
  const [tokenId, setTokenId] = useState('');
  const [secret, setSecret] = useState('');
  const [username, setUsername] = useState('root');
  const [realm, setRealm] = useState('pam');
  const [password, setPassword] = useState('');

  const [pending, setPending] = useState<'probe' | 'create' | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);

  const sitesForTenant = sites.filter((site) => site.tenantId === tenantId);

  async function probe(event: FormEvent) {
    event.preventDefault();
    setPending('probe');
    setFailure(null);
    setCertificate(null);
    setConfirmed(false);

    const result = await apiPost<CertificateReport>('/clusters/probe', {
      host: host.trim(),
      port: Number(port),
    });
    setPending(null);

    if (!result.ok) {
      setFailure(result.error);
      return;
    }

    setCertificate(result.data);
    // A sensible default the operator can change: the hostname without its
    // domain is what people call the cluster nine times out of ten.
    if (!name) setName(host.trim().split('.')[0] ?? host.trim());
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!certificate) return;

    setPending('create');
    setFailure(null);

    const result = await apiPost('/clusters', {
      tenantId,
      siteId: siteId || null,
      name,
      host: host.trim(),
      port: Number(port),
      fingerprint: certificate.fingerprint,
      auth:
        authKind === 'API_TOKEN'
          ? { kind: 'API_TOKEN', tokenId: tokenId.trim(), secret }
          : { kind: 'TICKET', username: username.trim(), realm: realm.trim(), password },
    });

    setPending(null);

    if (!result.ok) {
      setFailure(result.error);
      return;
    }

    onDone();
  }

  return (
    <Card title={t('clusters.addTitle')} description={t('clusters.addSubtitle')}>
      <div className="space-y-5">
        {failure && <FormError>{describeError(failure)}</FormError>}

        {/* Step 1 --------------------------------------------------------- */}
        <form onSubmit={probe} className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-muted">
            {t('clusters.step1')}
          </p>

          <div className="flex flex-wrap items-end gap-3">
            <Field label={t('clusters.host')} hint={t('clusters.hostHint')}>
              {(props) => (
                <TextInput
                  {...props}
                  value={host}
                  onChange={(event) => setHost(event.target.value)}
                  placeholder="pve1.example.com"
                  required
                  className="w-72"
                  autoFocus
                />
              )}
            </Field>

            <Field label={t('clusters.port')}>
              {(props) => (
                <TextInput
                  {...props}
                  type="number"
                  min={1}
                  max={65535}
                  value={port}
                  onChange={(event) => setPort(event.target.value)}
                  className="w-28"
                />
              )}
            </Field>

            <Button type="submit" variant="secondary" pending={pending === 'probe'}>
              {certificate ? t('clusters.probeAgain') : t('clusters.probe')}
            </Button>
          </div>

          <p className="text-xs text-ink-muted">{t('clusters.probeExplainer')}</p>
        </form>

        {/* Step 2 --------------------------------------------------------- */}
        {certificate && (
          <div className="space-y-3 border-t border-line pt-4">
            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-muted">
              {t('clusters.step2')}
            </p>

            {!certificate.respondedAsProxmox && (
              <Notice tone="warn" title={t('clusters.notProxmoxTitle')}>
                {t('clusters.notProxmoxBody')}
              </Notice>
            )}

            <Fingerprint value={certificate.fingerprint} />

            <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
              <Detail label={t('clusters.certSubject')} value={certificate.subject} />
              <Detail label={t('clusters.certIssuer')} value={certificate.issuer} />
              <Detail label={t('clusters.certValidTo')} value={certificate.validTo} />
              <Detail
                label={t('clusters.certTrusted')}
                value={certificate.trustedByCa ? t('common.yes') : t('clusters.selfSigned')}
              />
            </dl>

            <Notice tone="neutral" title={t('clusters.confirmTitle')}>
              <p>{t('clusters.confirmBody')}</p>
              <p className="mt-2">
                <code className="rounded border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-ink">
                  pvenode cert info
                </code>
              </p>
              <label className="mt-3 flex items-start gap-2 text-ink">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                  className="mt-0.5"
                />
                <span>{t('clusters.confirmCheckbox')}</span>
              </label>
            </Notice>
          </div>
        )}

        {/* Step 3 --------------------------------------------------------- */}
        {certificate && confirmed && (
          <form onSubmit={create} className="space-y-3 border-t border-line pt-4">
            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-muted">
              {t('clusters.step3')}
            </p>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('clusters.name')}>
                {(props) => (
                  <TextInput
                    {...props}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    required
                    minLength={2}
                  />
                )}
              </Field>

              <Field label={t('sites.tenant')}>
                {(props) => (
                  <select
                    {...props}
                    value={tenantId}
                    onChange={(event) => {
                      setTenantId(event.target.value);
                      setSiteId('');
                    }}
                    className="h-9 w-full rounded border border-line bg-surface px-2.5 text-sm text-ink"
                  >
                    {tenants.map((tenant) => (
                      <option key={tenant.id} value={tenant.id}>
                        {tenant.name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>

              <Field label={t('nav.sites')} hint={t('clusters.siteHint')}>
                {(props) => (
                  <select
                    {...props}
                    value={siteId}
                    onChange={(event) => setSiteId(event.target.value)}
                    className="h-9 w-full rounded border border-line bg-surface px-2.5 text-sm text-ink"
                  >
                    <option value="">{t('clusters.noSite')}</option>
                    {sitesForTenant.map((site) => (
                      <option key={site.id} value={site.id}>
                        {site.name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>

              <Field label={t('clusters.authKind')} hint={t('clusters.authKindHint')}>
                {(props) => (
                  <select
                    {...props}
                    value={authKind}
                    onChange={(event) => setAuthKind(event.target.value as 'API_TOKEN' | 'TICKET')}
                    className="h-9 w-full rounded border border-line bg-surface px-2.5 text-sm text-ink"
                  >
                    <option value="API_TOKEN">{t('clusters.authToken')}</option>
                    <option value="TICKET">{t('clusters.authPassword')}</option>
                  </select>
                )}
              </Field>
            </div>

            {authKind === 'API_TOKEN' ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t('clusters.tokenId')} hint={t('clusters.tokenIdHint')}>
                  {(props) => (
                    <TextInput
                      {...props}
                      value={tokenId}
                      onChange={(event) => setTokenId(event.target.value)}
                      placeholder="root@pam!velnox"
                      required
                      autoComplete="off"
                    />
                  )}
                </Field>
                <Field label={t('clusters.tokenSecret')}>
                  {(props) => (
                    <TextInput
                      {...props}
                      type="password"
                      value={secret}
                      onChange={(event) => setSecret(event.target.value)}
                      required
                      autoComplete="off"
                    />
                  )}
                </Field>
              </div>
            ) : (
              <>
                <Notice tone="warn">{t('clusters.passwordWarning')}</Notice>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label={t('clusters.username')}>
                    {(props) => (
                      <TextInput
                        {...props}
                        value={username}
                        onChange={(event) => setUsername(event.target.value)}
                        required
                        autoComplete="off"
                      />
                    )}
                  </Field>
                  <Field label={t('clusters.realm')}>
                    {(props) => (
                      <TextInput
                        {...props}
                        value={realm}
                        onChange={(event) => setRealm(event.target.value)}
                        required
                        autoComplete="off"
                      />
                    )}
                  </Field>
                  <Field label={t('clusters.password')}>
                    {(props) => (
                      <TextInput
                        {...props}
                        type="password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        required
                        autoComplete="off"
                      />
                    )}
                  </Field>
                </div>
              </>
            )}

            <div className="flex gap-2">
              <Button type="submit" pending={pending === 'create'}>
                {t('clusters.add')}
              </Button>
              <Button type="button" variant="quiet" onClick={onCancel}>
                {t('common.cancel')}
              </Button>
            </div>

            <p className="text-xs text-ink-muted">{t('clusters.createExplainer')}</p>
          </form>
        )}

        {!certificate && (
          <Button type="button" variant="quiet" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        )}
      </div>
    </Card>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-ink-muted">{label}</dt>
      <dd className="min-w-0 break-words text-ink">{value || '—'}</dd>
    </div>
  );
}

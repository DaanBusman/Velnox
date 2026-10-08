'use client';

import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import type { TlsStatusResponse } from '@velnox/shared';
import { CopyField } from '@/components/copy-field';
import { Card, KeyValue, Mono, Notice, StatusBadge } from '@/components/ui/primitives';
import { useApiResource } from './use-api-resource';
import { PanelError, PanelLoading } from './panel-state';
import { CertificateChange } from './certificate-change';

/** Below this, a certificate is close enough to expiry to say so loudly. */
const EXPIRY_WARNING_DAYS = 30;

/**
 * The certificate this installation serves, and changing it.
 *
 * Changed here since Phase 5C (ADR-045, reversing the read-only panel at the
 * owner's request): the API writes Caddy's files and reloads it through its
 * admin socket, without a shell command. `scripts/tls.sh` on the host stays as
 * the way back when this page cannot be reached, and this panel shows it.
 *
 * What it answers that configuration cannot: the certificate shown here is the
 * one the proxy actually presented on a real handshake a moment ago. The usual failure after changing a certificate is that the file
 * was written and the proxy never picked it up, and a screen sourced from
 * configuration reports success for exactly that case.
 */
export function CertificatePanel() {
  const t = useTranslations();
  const format = useFormatter();
  const tls = useApiResource<TlsStatusResponse>('/system/tls');
  // What the last change read back; newer than the page's first load.
  const [latest, setLatest] = useState<TlsStatusResponse | null>(null);

  if (tls.state === 'loading') return <PanelLoading />;
  if (tls.state === 'failed') return <PanelError error={tls.error} />;

  const status = latest ?? tls.data;
  const cert = status.certificate;
  const days = cert?.daysRemaining ?? null;
  const expired = days !== null && days < 0;
  const expiringSoon = days !== null && days >= 0 && days <= EXPIRY_WARNING_DAYS;

  const suffix = status.siteAddress.includes('.')
    ? status.siteAddress.split('.').slice(-2).join('.')
    : 'example.com';

  return (
    <div className="space-y-5">
      {/* The problems first: someone opening this is usually here because a
          browser complained. */}
      {expired && (
        <Notice tone="error" title={t('tls.expiredTitle')}>
          {t('tls.expiredBody')}
        </Notice>
      )}

      {expiringSoon && (
        <Notice tone="warn" title={t('tls.expiringTitle', { days: days ?? 0 })}>
          {status.mode === 'acme' ? t('tls.expiringAcme') : t('tls.expiringManual')}
        </Notice>
      )}

      {!status.reachable && (
        <Notice tone="error" title={t('tls.unreachableTitle')}>
          {t('tls.unreachableBody', { detail: String(status.problem?.params?.detail ?? '') })}
        </Notice>
      )}

      {status.reachable && !cert && (
        <Notice tone="warn" title={t('tls.noCertificateTitle')}>
          {t('tls.noCertificateBody')}
        </Notice>
      )}

      <Card
        title={t('tls.configuredTitle')}
        description={t('tls.configuredBody')}
        actions={
          <StatusBadge tone={status.mode === 'internal' ? 'neutral' : 'ok'}>
            {t(`tls.mode.${status.mode}`)}
          </StatusBadge>
        }
      >
        <dl>
          <KeyValue label={t('tls.address')}>
            <Mono>{status.siteAddress}</Mono>
          </KeyValue>
          <KeyValue label={t('tls.managedBy')}>
            {t(`tls.managedByValue.${status.managedBy}`)}
            {status.changedAt && status.changedBy && (
              <span className="text-ink-muted">
                {' '}
                — {t('tls.changedBy', { who: status.changedBy })},{' '}
                {format.dateTime(new Date(status.changedAt), {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              </span>
            )}
          </KeyValue>
          {status.acmeAccount && (
            <KeyValue label={t('tls.acmeAccount')}>{status.acmeAccount}</KeyValue>
          )}
          {status.acmeDirectory && (
            <KeyValue label={t('tls.acmeDirectory')}>
              <Mono>{status.acmeDirectory}</Mono>
            </KeyValue>
          )}
        </dl>
        <p className="mt-3 text-sm text-ink-muted">{t(`tls.modeExplained.${status.mode}`)}</p>
      </Card>

      {cert && (
        <Card title={t('tls.servedTitle')} description={t('tls.servedBody')}>
          <dl>
            <KeyValue label={t('tls.subject')}>
              <Mono>{cert.subject || t('common.unknown')}</Mono>
            </KeyValue>
            <KeyValue label={t('tls.issuer')}>
              <Mono>{cert.issuer || t('common.unknown')}</Mono>
              {cert.selfSigned && (
                <>
                  {' '}
                  <StatusBadge tone="neutral">{t('tls.selfSigned')}</StatusBadge>
                </>
              )}
            </KeyValue>
            <KeyValue label={t('tls.names')}>
              {cert.names.length > 0 ? (
                <ul className="flex flex-wrap gap-1.5">
                  {cert.names.map((name) => (
                    <li
                      key={name}
                      className="rounded border border-line bg-surface-2 px-2 py-0.5 font-mono text-xs text-ink"
                    >
                      {name}
                    </li>
                  ))}
                </ul>
              ) : (
                t('common.unknown')
              )}
            </KeyValue>
            <KeyValue label={t('tls.expires')}>
              {cert.notAfter
                ? `${format.dateTime(new Date(cert.notAfter), { dateStyle: 'long' })}${
                    // Only while there is time left. A negative count would
                    // render as "-3 days left"; an expired certificate is
                    // already stated in the notice above.
                    days === null || days < 0 ? '' : ` — ${t('tls.daysRemaining', { days })}`
                  }`
                : t('common.unknown')}
            </KeyValue>
            {cert.fingerprintSha256 && (
              <KeyValue label={t('tls.fingerprint')}>
                <span className="break-all font-mono text-xs text-ink">
                  {cert.fingerprintSha256}
                </span>
              </KeyValue>
            )}
          </dl>

          {/* Worth saying next to a certificate that does not cover the address:
              it is the difference between "browsers warn once" and "browsers
              refuse". */}
          {cert.names.length > 0 && !coversAddress(cert.names, status.siteAddress) && (
            <div className="mt-3">
              <Notice tone="warn" title={t('tls.mismatchTitle')}>
                {t('tls.mismatchBody', { address: status.siteAddress })}
              </Notice>
            </div>
          )}
        </Card>
      )}

      <CertificateChange status={status} onChanged={setLatest} />

      <Card title={t('tls.hostTitle')} description={t('tls.changeBody')}>
        <div className="space-y-4">
          <CopyField
            label={t('tls.commandStatus')}
            value="sudo bash /opt/velnox/scripts/tls.sh --status"
          />
          <CopyField
            label={t('tls.commandLetsencrypt')}
            value={`sudo bash /opt/velnox/scripts/tls.sh --letsencrypt=you@${suffix}`}
          />
          <CopyField
            label={t('tls.commandUpload')}
            value={
              'sudo bash /opt/velnox/scripts/tls.sh \\\n' +
              '  --certificate=/path/to/fullchain.pem \\\n' +
              '  --key=/path/to/privkey.pem'
            }
          />
          <CopyField
            label={t('tls.commandSelfSigned')}
            value="sudo bash /opt/velnox/scripts/tls.sh --self-signed"
          />
        </div>

        <p className="mt-4 text-sm text-ink-muted">{t('tls.whyNotHere')}</p>
      </Card>
    </div>
  );
}

/**
 * Does any name on the certificate cover the address, allowing one level of
 * wildcard?
 *
 * The same rule `scripts/tls.sh` applies before installing a certificate, and
 * the same rule a browser applies: `*.example.com` covers `host.example.com`
 * and not `deep.host.example.com`.
 */
function coversAddress(names: string[], address: string): boolean {
  return names.some((name) => {
    if (name === address) return true;
    if (!name.startsWith('*.') || !address.includes('.')) return false;
    return address.slice(address.indexOf('.') + 1) === name.slice(2);
  });
}

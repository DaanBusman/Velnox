'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { apiPost, apiPut, type ApiFailure } from '@/lib/client-api';
import { useApiError } from '@/lib/use-api-error';
import type { MailSettingsView } from '@/lib/session';
import { Button, Field, FormError, TextInput } from '@/components/ui/form';
import { Card, Notice, StatusBadge } from '@/components/ui/primitives';

const select =
  'block h-9 w-full rounded border border-line bg-surface-2 px-2.5 text-sm text-ink focus:border-accent focus:outline-none';

/**
 * Outgoing mail.
 *
 * Three steps, in the order they have to happen: save the server, send a test,
 * switch mail on. Changing the server switches it off again until a new test
 * goes out, because a notification that silently fails is worse than none. The
 * password is write-only.
 */
export function MailSettings({
  initial,
  defaultTo,
}: {
  initial: MailSettingsView;
  defaultTo: string;
}) {
  const t = useTranslations();
  const format = useFormatter();
  const router = useRouter();
  const describeError = useApiError();
  const [settings, setSettings] = useState(initial);
  const [host, setHost] = useState(initial.host ?? '');
  const [port, setPort] = useState(String(initial.port));
  const [security, setSecurity] = useState(initial.security);
  const [username, setUsername] = useState(initial.username ?? '');
  const [password, setPassword] = useState('');
  const [from, setFrom] = useState(initial.from ?? '');
  const [to, setTo] = useState(defaultTo);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function run(
    kind: string,
    action: () => Promise<{ ok: true; data: MailSettingsView } | { ok: false; error: ApiFailure }>,
    done: string,
  ) {
    setPending(kind);
    setFailure(null);
    setMessage(null);
    const result = await action();
    setPending(null);
    if (!result.ok) return setFailure(result.error);
    setSettings(result.data);
    setPassword('');
    setMessage(done);
    router.refresh();
  }

  const save = () =>
    run(
      'save',
      () =>
        apiPut<MailSettingsView>('/system/mail', {
          host: host.trim() || null,
          port: Number(port),
          security,
          username: username.trim() || null,
          from: from.trim() || null,
          ...(password ? { password } : {}),
        }),
      t('mail.saved'),
    );

  return (
    <div className="space-y-4">
      <Card title={t('mail.statusTitle')}>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <StatusBadge tone={settings.enabled ? 'ok' : 'neutral'}>
            {settings.enabled ? t('mail.enabled') : t('mail.disabled')}
          </StatusBadge>
          <span className="text-ink-muted">
            {settings.verifiedAt
              ? t('mail.verifiedAt', {
                  when: format.dateTime(new Date(settings.verifiedAt), {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  }),
                })
              : t('mail.notVerified')}
          </span>
        </div>
      </Card>

      <Card title={t('mail.serverTitle')} description={t('mail.serverDescription')}>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label={t('mail.host')}>
            {(props) => (
              <TextInput {...props} value={host} onChange={(e) => setHost(e.target.value)} />
            )}
          </Field>
          <Field label={t('mail.port')}>
            {(props) => (
              <TextInput
                {...props}
                inputMode="numeric"
                value={port}
                onChange={(e) => setPort(e.target.value)}
              />
            )}
          </Field>
          <Field
            label={t('mail.security')}
            hint={security === 'NONE' ? t('mail.securityNoneHint') : undefined}
          >
            {(props) => (
              <select
                {...props}
                className={select}
                value={security}
                onChange={(e) => setSecurity(e.target.value as MailSettingsView['security'])}
              >
                <option value="STARTTLS">{t('mail.starttls')}</option>
                <option value="TLS">{t('mail.tls')}</option>
                <option value="NONE">{t('mail.none')}</option>
              </select>
            )}
          </Field>
          <Field label={t('mail.from')}>
            {(props) => (
              <TextInput
                {...props}
                type="email"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            )}
          </Field>
          <Field label={t('mail.username')}>
            {(props) => (
              <TextInput
                {...props}
                autoComplete="off"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            )}
          </Field>
          <Field
            label={t('mail.password')}
            hint={settings.passwordSet ? t('mail.passwordStored') : undefined}
          >
            {(props) => (
              <TextInput
                {...props}
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            )}
          </Field>
        </div>
        <div className="mt-3 flex gap-2">
          <Button onClick={() => void save()} pending={pending === 'save'}>
            {t('common.save')}
          </Button>
          {settings.passwordSet && (
            <Button
              variant="quiet"
              onClick={() =>
                void run(
                  'clear',
                  () => apiPut<MailSettingsView>('/system/mail', { password: null }),
                  t('mail.passwordCleared'),
                )
              }
              pending={pending === 'clear'}
            >
              {t('mail.clearPassword')}
            </Button>
          )}
        </div>
      </Card>

      <Card title={t('mail.testTitle')} description={t('mail.testDescription')}>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-64 flex-1">
            <Field label={t('mail.testTo')}>
              {(props) => (
                <TextInput
                  {...props}
                  type="email"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
              )}
            </Field>
          </div>
          <Button
            variant="secondary"
            onClick={() =>
              void run(
                'test',
                () => apiPost<MailSettingsView>('/system/mail/test', { to: to.trim() }),
                t('mail.testSent', { to }),
              )
            }
            pending={pending === 'test'}
            disabled={!settings.host || !settings.from || !to.trim()}
          >
            {t('mail.sendTest')}
          </Button>
          <Button
            onClick={() =>
              void run(
                'toggle',
                () => apiPut<MailSettingsView>('/system/mail', { enabled: !settings.enabled }),
                settings.enabled ? t('mail.switchedOff') : t('mail.switchedOn'),
              )
            }
            pending={pending === 'toggle'}
            disabled={!settings.enabled && !settings.verifiedAt}
          >
            {settings.enabled ? t('mail.switchOff') : t('mail.switchOn')}
          </Button>
        </div>
      </Card>

      {failure && <FormError>{describeError(failure)}</FormError>}
      {message && <Notice tone="ok">{message}</Notice>}
    </div>
  );
}

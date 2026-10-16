'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import {
  canGenerateEd25519,
  generateOpenSshEd25519,
  type ClusterSshProbe,
  type ClusterSshStatus,
  type OpenSshKeyPair,
} from '@velnox/shared';
import { apiDelete, apiPost, apiPut, type ApiFailure } from '@/lib/client-api';
import { useApiError } from '@/lib/use-api-error';
import { CopyField } from '@/components/copy-field';
import { Button, Field, FormError, TextInput } from '@/components/ui/form';
import { Card, KeyValue, Notice, StatusBadge } from '@/components/ui/primitives';

/** Where an account's authorized_keys is, for the command shown to the operator. */
const authorizedKeysOf = (username: string) =>
  username === 'root' ? '/root/.ssh/authorized_keys' : `/home/${username}/.ssh/authorized_keys`;

/**
 * SSH on a cluster, set up the way the cluster itself was added.
 *
 * Read each node's host key without logging in; compare it with the node;
 * confirm it; only then hand over a key, which is proven against every
 * confirmed node before it is kept.
 *
 * The key is made here by default — an Ed25519 pair from the browser's
 * WebCrypto — and its public half is shown with the command that puts it on
 * the nodes, because "paste a private key whose public half is in
 * authorized_keys" left the operator to find out where the public half comes
 * from. The public half stays visible on this card afterwards. What SSH is for
 * is said plainly: since Phase 6 it runs the fixed commands of updates and
 * upgrades, as root, not only SFTP.
 */
export function ClusterSsh({
  clusterId,
  ssh,
  canManage,
  onEditing,
}: {
  clusterId: string;
  ssh: ClusterSshStatus | null;
  canManage: boolean;
  /** Tells the page to hold its auto-refresh while the form is open. */
  onEditing: (editing: boolean) => void;
}) {
  const t = useTranslations();
  const format = useFormatter();
  const router = useRouter();
  const describeError = useApiError();

  const [open, setOpen] = useState(false);
  const [port, setPort] = useState(String(ssh?.port ?? 22));
  const [probe, setProbe] = useState<ClusterSshProbe | null>(null);
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [username, setUsername] = useState(ssh?.username ?? 'root');
  const [keySource, setKeySource] = useState<'generate' | 'existing'>('generate');
  const [canGenerate, setCanGenerate] = useState<boolean | null>(null);
  const [generated, setGenerated] = useState<OpenSshKeyPair | null>(null);
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    if (!open || canGenerate !== null) return;
    void canGenerateEd25519().then((able) => {
      setCanGenerate(able);
      if (!able) setKeySource('existing');
    });
  }, [open, canGenerate]);

  const editing = (value: boolean) => {
    setOpen(value);
    onEditing(value);
    if (!value) {
      setProbe(null);
      setConfirmed(new Set());
      setGenerated(null);
      setPrivateKey('');
      setPassphrase('');
    }
  };

  async function generate() {
    setPending('generate');
    setFailure(null);
    try {
      setGenerated(await generateOpenSshEd25519('velnox'));
    } finally {
      setPending(null);
    }
  }

  const keyToSend = keySource === 'generate' ? (generated?.privateKey ?? '') : privateKey;

  async function readKeys() {
    setPending('probe');
    setFailure(null);
    const result = await apiPost<ClusterSshProbe>(`/clusters/${clusterId}/ssh/probe`, {
      port: Number(port),
    });
    setPending(null);
    if (!result.ok) return setFailure(result.error);
    setProbe(result.data);
    setConfirmed(new Set());
  }

  async function save() {
    if (!probe) return;
    setPending('save');
    setFailure(null);
    const hostKeys = probe.nodes
      .filter((node) => node.fingerprint && confirmed.has(node.node))
      .map((node) => ({ node: node.node, fingerprint: node.fingerprint! }));
    const result = await apiPut(`/clusters/${clusterId}/ssh`, {
      username: username.trim(),
      port: Number(port),
      privateKey: keyToSend,
      passphrase: keySource === 'existing' ? passphrase || null : null,
      hostKeys,
    });
    setPending(null);
    // A pasted key is dropped from memory whatever happened; a retry pastes it
    // again. A generated one is kept until the form closes: its public half may
    // already be on the nodes, and a refusal usually means it is not on one yet.
    setPrivateKey('');
    setPassphrase('');
    if (!result.ok) return setFailure(result.error);
    editing(false);
    router.refresh();
  }

  async function remove() {
    setPending('remove');
    const result = await apiDelete(`/clusters/${clusterId}/ssh`);
    setPending(null);
    setConfirmRemove(false);
    if (!result.ok) return setFailure(result.error);
    router.refresh();
  }

  return (
    <Card title={t('clusters.ssh.title')} description={t('clusters.ssh.description')}>
      <div className="space-y-3">
        {failure && <FormError>{describeError(failure)}</FormError>}

        {ssh?.configured ? (
          <dl>
            <KeyValue label={t('clusters.ssh.account')}>
              <span className="font-mono text-xs">
                {ssh.username}@…:{ssh.port}
              </span>
            </KeyValue>
            <KeyValue label={t('clusters.ssh.verified')}>
              {ssh.verifiedAt ? (
                format.dateTime(new Date(ssh.verifiedAt), 'medium')
              ) : (
                <StatusBadge tone="warn">{t('clusters.ssh.notVerified')}</StatusBadge>
              )}
            </KeyValue>
            <div className="py-2">
              {ssh.publicKey ? (
                <CopyField
                  label={t('clusters.ssh.publicKey')}
                  value={ssh.publicKey}
                  hint={t('clusters.ssh.publicKeyHint', {
                    path: authorizedKeysOf(ssh.username ?? 'root'),
                  })}
                />
              ) : (
                <p className="text-xs text-ink-muted">{t('clusters.ssh.publicKeyUnknown')}</p>
              )}
            </div>
            {ssh.nodes.map((node) => (
              <KeyValue key={node.node} label={node.node}>
                {node.fingerprint ? (
                  <span className="font-mono text-xs">{node.fingerprint}</span>
                ) : (
                  <span className="text-xs text-warn">{t('clusters.ssh.noKeyConfirmed')}</span>
                )}
              </KeyValue>
            ))}
          </dl>
        ) : (
          <p className="text-sm text-ink-muted">{t('clusters.ssh.notConfigured')}</p>
        )}

        {canManage && !open && (
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => editing(true)}>
              {ssh?.configured ? t('clusters.ssh.replace') : t('clusters.ssh.setUp')}
            </Button>
            {ssh?.configured &&
              (confirmRemove ? (
                <>
                  <Button
                    variant="secondary"
                    pending={pending === 'remove'}
                    onClick={() => void remove()}
                  >
                    {t('clusters.ssh.removeConfirm')}
                  </Button>
                  <Button variant="quiet" onClick={() => setConfirmRemove(false)}>
                    {t('common.cancel')}
                  </Button>
                </>
              ) : (
                <Button variant="quiet" onClick={() => setConfirmRemove(true)}>
                  {t('clusters.ssh.remove')}
                </Button>
              ))}
          </div>
        )}

        {open && (
          <div className="space-y-3 rounded border border-line p-3">
            <p className="text-xs text-ink-muted">{t('clusters.ssh.whatFor')}</p>
            <p className="text-sm font-medium text-ink">{t('clusters.ssh.stepHostKeys')}</p>
            <div className="flex items-end gap-2">
              <Field label={t('clusters.ssh.port')}>
                {(props) => (
                  <TextInput
                    {...props}
                    type="number"
                    min={1}
                    max={65535}
                    value={port}
                    onChange={(event) => setPort(event.target.value)}
                  />
                )}
              </Field>
              <Button
                variant="secondary"
                pending={pending === 'probe'}
                onClick={() => void readKeys()}
              >
                {t('clusters.ssh.readKeys')}
              </Button>
            </div>

            {probe && (
              <div className="space-y-2">
                <p className="text-xs text-ink-muted">{t('clusters.ssh.compareHint')}</p>
                <code className="block rounded bg-surface-3 px-2 py-1 text-xs">
                  ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
                </code>
                <ul className="space-y-1">
                  {probe.nodes.map((node) => (
                    <li key={node.node} className="flex items-start gap-2 text-sm">
                      {node.fingerprint ? (
                        <label className="flex items-start gap-2">
                          <input
                            type="checkbox"
                            className="mt-1"
                            checked={confirmed.has(node.node)}
                            onChange={(event) => {
                              const next = new Set(confirmed);
                              if (event.target.checked) next.add(node.node);
                              else next.delete(node.node);
                              setConfirmed(next);
                            }}
                          />
                          <span>
                            <span className="font-medium text-ink">{node.node}</span>{' '}
                            <span className="text-xs text-ink-muted">({node.host})</span>
                            <span className="block font-mono text-xs text-ink">
                              {node.fingerprint}
                            </span>
                            <span className="text-xs text-ink-muted">{node.keyType}</span>
                          </span>
                        </label>
                      ) : (
                        <span className="text-ink-muted">
                          <span className="font-medium">{node.node}</span> —{' '}
                          {t('clusters.ssh.noKey', { reason: node.error ?? '' })}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>

                <p className="pt-2 text-sm font-medium text-ink">{t('clusters.ssh.stepAccount')}</p>
                <Field label={t('clusters.ssh.username')} hint={t('clusters.ssh.usernameHint')}>
                  {(props) => (
                    <TextInput
                      {...props}
                      value={username}
                      onChange={(event) => setUsername(event.target.value)}
                      autoComplete="off"
                    />
                  )}
                </Field>
                <p className="pt-2 text-sm font-medium text-ink">{t('clusters.ssh.stepKey')}</p>
                <div className="space-y-1 text-sm">
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="ssh-key-source"
                      checked={keySource === 'generate'}
                      disabled={canGenerate === false}
                      onChange={() => setKeySource('generate')}
                    />
                    {t('clusters.ssh.keyGenerate')}
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="ssh-key-source"
                      checked={keySource === 'existing'}
                      onChange={() => setKeySource('existing')}
                    />
                    {t('clusters.ssh.keyExisting')}
                  </label>
                  {canGenerate === false && (
                    <p className="text-xs text-ink-muted">
                      {t('clusters.ssh.keyGenerateUnsupported')}
                    </p>
                  )}
                </div>

                {keySource === 'generate' &&
                  (generated ? (
                    <div className="space-y-2">
                      <p className="text-xs text-ink-muted">{t('clusters.ssh.generated')}</p>
                      <CopyField label={t('clusters.ssh.publicKey')} value={generated.publicKey} />
                      <Notice tone="warn" title={t('clusters.ssh.addKeyTitle')}>
                        <p>{t('clusters.ssh.addKeyBody')}</p>
                      </Notice>
                      <CopyField
                        label={t('clusters.ssh.addKeyCommand')}
                        value={`echo '${generated.publicKey}' >> ${authorizedKeysOf(username.trim() || 'root')}`}
                      />
                    </div>
                  ) : (
                    <Button
                      variant="secondary"
                      pending={pending === 'generate'}
                      onClick={() => void generate()}
                    >
                      {t('clusters.ssh.generate')}
                    </Button>
                  ))}

                {keySource === 'existing' && (
                  <>
                    <Field
                      label={t('clusters.ssh.privateKey')}
                      hint={t('clusters.ssh.privateKeyHint')}
                    >
                      {(props) => (
                        <textarea
                          {...props}
                          value={privateKey}
                          onChange={(event) => setPrivateKey(event.target.value)}
                          rows={6}
                          spellCheck={false}
                          autoComplete="off"
                          className="block w-full rounded border border-line bg-surface-2 px-2.5 py-2 font-mono text-xs text-ink focus:border-accent focus:outline-none"
                        />
                      )}
                    </Field>
                    <Field label={t('clusters.ssh.passphrase')}>
                      {(props) => (
                        <TextInput
                          {...props}
                          type="password"
                          value={passphrase}
                          onChange={(event) => setPassphrase(event.target.value)}
                          autoComplete="off"
                        />
                      )}
                    </Field>
                  </>
                )}
                <div className="flex gap-2">
                  <Button
                    pending={pending === 'save'}
                    disabled={
                      confirmed.size === 0 ||
                      keyToSend.trim().length === 0 ||
                      username.trim().length === 0
                    }
                    onClick={() => void save()}
                  >
                    {t('clusters.ssh.save')}
                  </Button>
                  <Button variant="secondary" onClick={() => editing(false)}>
                    {t('common.cancel')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
        {ssh?.configured && ssh.nodes.some((node) => !node.fingerprint) && (
          <Notice tone="warn">{t('clusters.ssh.unconfirmedNodes')}</Notice>
        )}
      </div>
    </Card>
  );
}

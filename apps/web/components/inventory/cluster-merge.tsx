'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import type { ClusterMergeCandidate } from '@velnox/shared';
import { apiPost, type ApiFailure } from '@/lib/client-api';
import { useApiError } from '@/lib/use-api-error';
import { Button, Field, FormError, TextInput } from '@/components/ui/form';
import { Notice } from '@/components/ui/primitives';

/**
 * Registrations that are one Proxmox cluster, and the window that merges two
 * of them (ADR-055).
 *
 * Shown only when Velnox has seen it: the same tenant, the same name from
 * Proxmox, nodes in common — servers added one by one and joined in Proxmox
 * afterwards. Velnox joins nothing itself; it makes its own records one.
 */
export function ClusterMergeNotices({ candidates }: { candidates: ClusterMergeCandidate[] }) {
  const t = useTranslations();
  const format = useFormatter();
  const [open, setOpen] = useState<ClusterMergeCandidate | null>(null);

  if (!candidates.length) return null;
  return (
    <div className="mb-5 space-y-3">
      {candidates.map((candidate) => (
        <Notice
          key={candidate.clusters.map((c) => c.id).join()}
          tone="warn"
          title={t('clusters.merge.noticeTitle', { cluster: candidate.pveClusterName })}
        >
          <p>
            {t('clusters.merge.noticeBody', {
              registrations: format.list(candidate.clusters.map((c) => c.name)),
              cluster: candidate.pveClusterName,
              nodes: format.list(candidate.nodes),
            })}
          </p>
          <div className="mt-2">
            <Button variant="secondary" onClick={() => setOpen(candidate)}>
              {t('clusters.merge.open')}
            </Button>
          </div>
        </Notice>
      ))}
      {open && <MergeDialog candidate={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function MergeDialog({
  candidate,
  onClose,
}: {
  candidate: ClusterMergeCandidate;
  onClose: () => void;
}) {
  const t = useTranslations();
  const router = useRouter();
  const describeError = useApiError();
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(candidate.pveClusterName);
  const [keepId, setKeepId] = useState(candidate.clusters[0]!.id);
  const [removeId, setRemoveId] = useState(candidate.clusters[1]!.id);
  const [sshFrom, setSshFrom] = useState<'keep' | 'remove'>('keep');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  const keep = candidate.clusters.find((c) => c.id === keepId)!;
  const remove = candidate.clusters.find((c) => c.id === removeId)!;
  const bothSsh = keep.sshConfigured && remove.sshConfigured;

  // Keeping one means removing another: never the same one twice.
  const chooseKeep = (id: string) => {
    setKeepId(id);
    if (id === removeId) setRemoveId(candidate.clusters.find((c) => c.id !== id)!.id);
  };

  async function merge() {
    setPending(true);
    setFailure(null);
    const result = await apiPost('/clusters/merge', {
      keepId,
      removeId,
      name: name.trim(),
      sshFrom,
    });
    setPending(false);
    if (!result.ok) return setFailure(result.error);
    ref.current?.close();
    router.refresh();
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby="merge-title"
      onClose={onClose}
      className="m-auto w-[min(40rem,calc(100vw-2rem))] max-h-[calc(100dvh-4rem)] overflow-y-auto rounded-lg border border-line bg-surface p-0 text-ink shadow-2xl backdrop:bg-black/50 backdrop:backdrop-blur-[2px]"
    >
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <h2 id="merge-title" className="text-sm font-semibold tracking-tight">
          {t('clusters.merge.title')}
        </h2>
        <button
          type="button"
          onClick={() => ref.current?.close()}
          aria-label={t('common.close')}
          className="grid size-7 place-items-center rounded text-ink-muted hover:bg-surface-2 hover:text-ink"
        >
          <span aria-hidden>×</span>
        </button>
      </div>
      <div className="space-y-4 p-5 text-sm">
        {failure && <FormError>{describeError(failure)}</FormError>}
        <Field label={t('clusters.merge.name')} hint={t('clusters.merge.nameHint')}>
          {(props) => (
            <TextInput
              {...props}
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>

        <fieldset className="space-y-1">
          <legend className="mb-1 text-xs font-medium text-ink">{t('clusters.merge.keep')}</legend>
          {candidate.clusters.map((c) => (
            <label key={c.id} className="flex items-center gap-2">
              <input
                type="radio"
                name="keep"
                checked={keepId === c.id}
                onChange={() => chooseKeep(c.id)}
              />
              <span>
                {c.name} <span className="font-mono text-xs text-ink-muted">{c.endpoint}</span>
              </span>
            </label>
          ))}
          <p className="text-xs text-ink-muted">{t('clusters.merge.keepHint')}</p>
        </fieldset>

        {candidate.clusters.length > 2 && (
          <fieldset className="space-y-1">
            <legend className="mb-1 text-xs font-medium text-ink">
              {t('clusters.merge.remove')}
            </legend>
            {candidate.clusters
              .filter((c) => c.id !== keepId)
              .map((c) => (
                <label key={c.id} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="remove"
                    checked={removeId === c.id}
                    onChange={() => setRemoveId(c.id)}
                  />
                  {c.name}
                </label>
              ))}
          </fieldset>
        )}

        {bothSsh && (
          <fieldset className="space-y-1">
            <legend className="mb-1 text-xs font-medium text-ink">{t('clusters.merge.ssh')}</legend>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="ssh"
                checked={sshFrom === 'keep'}
                onChange={() => setSshFrom('keep')}
              />
              {keep.name}
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="ssh"
                checked={sshFrom === 'remove'}
                onChange={() => setSshFrom('remove')}
              />
              {remove.name}
            </label>
          </fieldset>
        )}

        <Notice
          tone="neutral"
          title={t('clusters.merge.carriesTitle', { remove: remove.name, keep: name || keep.name })}
        >
          <p>{t('clusters.merge.carriesBody')}</p>
        </Notice>
        <p className="text-xs text-ink-muted">
          {t('clusters.merge.final', { remove: remove.name })}
        </p>

        <div className="flex gap-2 border-t border-line pt-4">
          <Button pending={pending} disabled={!name.trim()} onClick={() => void merge()}>
            {t('clusters.merge.submit')}
          </Button>
          <Button variant="secondary" onClick={() => ref.current?.close()}>
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    </dialog>
  );
}

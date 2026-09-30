'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import type { LibraryItemSummary, LibraryListResponse } from '@velnox/shared';
import { apiDelete, apiPatch, apiPost, type ApiFailure } from '@/lib/client-api';
import { useApiError } from '@/lib/use-api-error';
import { useAutoRefresh } from '@/lib/use-auto-refresh';
import { messageValues } from '@/lib/message-values';
import { Button, Field, FormError, TextInput } from '@/components/ui/form';
import { Card, Notice, StatusBadge } from '@/components/ui/primitives';
import { FriendlyName, useFriendlyName } from './friendly-name';
import { PushDialog } from './push-dialog';
import { uploadToLibrary } from './upload';

const bytes = (value: number | null, format: ReturnType<typeof useFormatter>): string => {
  if (value === null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${format.number(size, { maximumFractionDigits: unit >= 3 ? 1 : 0 })} ${units[unit]}`;
};

const stateTone = (state: LibraryItemSummary['state']) =>
  state === 'READY' ? 'ok' : state === 'FAILED' ? 'error' : 'warn';

/**
 * The ISO library.
 *
 * Every screen shows the friendly name and every log line the filename; here
 * both are on the row, because the one is what a person looks for and the
 * other is what Proxmox will call the file.
 */
export function LibraryView({
  data,
  canManage,
  canPush,
  refreshSeconds,
}: {
  data: LibraryListResponse;
  canManage: boolean;
  canPush: boolean;
  refreshSeconds: number;
}) {
  const t = useTranslations();
  const format = useFormatter();
  const router = useRouter();
  const describeError = useApiError();
  const friendly = useFriendlyName();

  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [url, setUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const [upload, setUpload] = useState<{ name: string; sent: number; total: number } | null>(null);
  const [resumeTarget, setResumeTarget] = useState<LibraryItemSummary | null>(null);
  const [pushing, setPushing] = useState<LibraryItemSummary | null>(null);
  const [renaming, setRenaming] = useState<LibraryItemSummary | null>(null);
  const [removing, setRemoving] = useState<LibraryItemSummary | null>(null);
  const [notice, setNotice] = useState<{ jobId: string; text: string } | null>(null);
  const uploadAbort = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const interacting = upload !== null || pushing !== null || renaming !== null || removing !== null;
  // Paused while anything is open or uploading: a refresh can remount the tree,
  // and an upload or a half-filled form that vanishes is work lost.
  useAutoRefresh(refreshSeconds * 1000, refreshSeconds > 0 && !interacting);

  const { capacity } = data;
  const usedPct = Math.min(100, (capacity.usedBytes / capacity.ceilingBytes) * 100);

  async function addFromUrl() {
    setFailure(null);
    setAdding(true);
    const result = await apiPost<{ item: LibraryItemSummary; job: { id: string } }>(
      '/library/url',
      { url: url.trim() },
    );
    setAdding(false);
    if (!result.ok) return setFailure(result.error);
    setUrl('');
    setNotice({
      jobId: result.data.job.id,
      text: t('library.fetchQueued', { filename: result.data.item.filename }),
    });
    router.refresh();
  }

  async function startUpload(file: File) {
    setFailure(null);
    const controller = new AbortController();
    uploadAbort.current = controller;
    setUpload({ name: file.name, sent: 0, total: file.size });
    const result = await uploadToLibrary({
      file,
      resume: resumeTarget ?? undefined,
      signal: controller.signal,
      onProgress: (sent, total) => setUpload({ name: file.name, sent, total }),
    });
    setUpload(null);
    setResumeTarget(null);
    uploadAbort.current = null;
    if (!result.ok) {
      if (result.error.code !== 'library.upload_paused') setFailure(result.error);
    } else if (result.job) {
      setNotice({
        jobId: result.job.id,
        text: t('library.uploadChecking', { filename: result.item.filename }),
      });
    }
    router.refresh();
  }

  async function saveRename(item: LibraryItemSummary, title: string, language: string | null) {
    const result = await apiPatch(`/library/${item.id}`, { title: title.trim() || null, language });
    if (!result.ok) return setFailure(result.error);
    setRenaming(null);
    router.refresh();
  }

  async function remove(item: LibraryItemSummary) {
    const result =
      item.state === 'RECEIVING' && item.source === 'UPLOAD' && !item.jobId
        ? await apiDelete(`/library/uploads/${item.id}`)
        : await apiDelete(`/library/${item.id}`);
    setRemoving(null);
    if (!result.ok) return setFailure(result.error);
    router.refresh();
  }

  return (
    <div className="space-y-4">
      {failure && <FormError>{describeError(failure)}</FormError>}
      {notice && (
        <Notice tone="neutral">
          {notice.text}{' '}
          <Link className="text-accent underline" href={`/jobs/${notice.jobId}`}>
            {t('library.followJob')}
          </Link>
        </Notice>
      )}

      <Card
        title={t('library.capacityTitle')}
        description={t('library.capacityDescription', {
          maxGb: capacity.maxGb,
          minFreeGb: capacity.minFreeGb,
        })}
        actions={
          <Button variant="secondary" onClick={() => router.refresh()}>
            {t('common.refresh')}
          </Button>
        }
      >
        <div className="h-2 w-full overflow-hidden rounded bg-surface-3" aria-hidden>
          <div
            className={
              usedPct > 90
                ? 'h-full bg-error'
                : usedPct > 75
                  ? 'h-full bg-warn'
                  : 'h-full bg-accent'
            }
            style={{ width: `${usedPct}%` }}
          />
        </div>
        <p className="mt-2 text-sm text-ink-muted">
          {t('library.capacityUsed', {
            used: bytes(capacity.usedBytes, format),
            ceiling: bytes(capacity.ceilingBytes, format),
            free: bytes(capacity.diskFreeBytes, format),
            floor: bytes(capacity.diskFloorBytes, format),
          })}
        </p>
      </Card>

      {canManage && (
        <Card title={t('library.addTitle')} description={t('library.addDescription')}>
          <div className="grid gap-4 lg:grid-cols-2">
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                void addFromUrl();
              }}
            >
              <Field label={t('library.fromUrl')} hint={t('library.fromUrlHint')}>
                {(props) => (
                  <TextInput
                    {...props}
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    placeholder="https://…/Win11_25H2_Dutch_x64.iso"
                    type="url"
                  />
                )}
              </Field>
              <Button type="submit" pending={adding} disabled={url.trim().length === 0}>
                {t('library.fetch')}
              </Button>
            </form>

            <div className="space-y-2">
              <Field
                label={
                  resumeTarget
                    ? t('library.resumeLabel', { filename: resumeTarget.filename })
                    : t('library.fromUpload')
                }
                hint={t('library.fromUploadHint')}
              >
                {(props) => (
                  <input
                    {...props}
                    ref={fileInput}
                    type="file"
                    accept=".iso,.img,.qcow2,.raw"
                    disabled={upload !== null}
                    className="block w-full text-sm text-ink file:mr-3 file:rounded file:border-0 file:bg-surface-3 file:px-3 file:py-1.5 file:text-sm file:text-ink"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = '';
                      if (file) void startUpload(file);
                    }}
                  />
                )}
              </Field>
              {upload && (
                <div className="space-y-1">
                  <div className="h-2 w-full overflow-hidden rounded bg-surface-3" aria-hidden>
                    <div
                      className="h-full bg-accent"
                      style={{ width: `${(upload.sent / upload.total) * 100}%` }}
                    />
                  </div>
                  <p className="text-xs text-ink-muted">
                    {t('library.uploading', {
                      filename: upload.name,
                      sent: bytes(upload.sent, format),
                      total: bytes(upload.total, format),
                    })}
                  </p>
                  <Button variant="secondary" onClick={() => uploadAbort.current?.abort()}>
                    {t('library.pause')}
                  </Button>
                </div>
              )}
            </div>
          </div>
        </Card>
      )}

      <Card title={t('library.itemsTitle')} description={t('library.itemsDescription')}>
        {data.items.length === 0 ? (
          <p className="text-sm text-ink-muted">{t('library.empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-ink-muted">
                  <th scope="col" className="py-1.5 pr-4 font-medium">
                    {t('library.name')}
                  </th>
                  <th scope="col" className="py-1.5 pr-4 font-medium">
                    {t('library.kind')}
                  </th>
                  <th scope="col" className="py-1.5 pr-4 text-right font-medium">
                    {t('library.size')}
                  </th>
                  <th scope="col" className="py-1.5 pr-4 font-medium">
                    {t('library.state')}
                  </th>
                  <th scope="col" className="py-1.5 pr-4 font-medium">
                    {t('library.source')}
                  </th>
                  <th scope="col" className="py-1.5 font-medium">
                    <span className="sr-only">{t('library.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => {
                  const inFlight = item.state === 'RECEIVING' || item.state === 'VERIFYING';
                  const pct =
                    item.sizeBytes && item.sizeBytes > 0
                      ? Math.floor((item.receivedBytes / item.sizeBytes) * 100)
                      : null;
                  return (
                    <tr key={item.id} className="border-b border-line align-top last:border-b-0">
                      <td className="py-2 pr-4">
                        <FriendlyName item={item} />
                        <div className="font-mono text-xs text-ink-muted">{item.filename}</div>
                        {item.state === 'FAILED' && item.errorCode && (
                          <div className="mt-1 text-xs text-error">
                            {t.has(`errors.${item.errorCode}`)
                              ? t(`errors.${item.errorCode}`, messageValues(item.errorParams))
                              : t('errors.generic')}
                          </div>
                        )}
                      </td>
                      <td className="py-2 pr-4 text-ink-muted">
                        {item.kind === 'ISO'
                          ? t('library.kindIso')
                          : t('library.kindDisk', { format: item.diskFormat ?? '—' })}
                      </td>
                      <td className="py-2 pr-4 text-right font-mono text-xs tabular-nums">
                        {bytes(item.sizeBytes, format)}
                      </td>
                      <td className="py-2 pr-4">
                        <StatusBadge tone={stateTone(item.state)}>
                          {t(`library.states.${item.state}`)}
                          {inFlight && pct !== null ? ` ${pct}%` : ''}
                        </StatusBadge>
                        {item.jobId && (
                          <Link
                            className="ml-2 text-xs text-accent underline"
                            href={`/jobs/${item.jobId}`}
                          >
                            {t('library.job')}
                          </Link>
                        )}
                      </td>
                      <td className="py-2 pr-4 text-xs text-ink-muted">
                        {item.source === 'URL' && (
                          <span title={item.sourceUrl ?? ''}>{t('library.sourceUrl')}</span>
                        )}
                        {item.source === 'UPLOAD' && t('library.sourceUpload')}
                        {item.source === 'CLUSTER' &&
                          t('library.sourceCluster', { cluster: item.sourceClusterName ?? '—' })}
                        {item.createdBy && <div>{item.createdBy}</div>}
                      </td>
                      <td className="py-2 text-right whitespace-nowrap">
                        <div className="flex justify-end gap-1">
                          {canPush && item.state === 'READY' && (
                            <Button variant="secondary" onClick={() => setPushing(item)}>
                              {t('library.push')}
                            </Button>
                          )}
                          {canManage &&
                            item.state === 'RECEIVING' &&
                            item.source === 'UPLOAD' &&
                            upload === null && (
                              <Button
                                variant="secondary"
                                onClick={() => {
                                  setResumeTarget(item);
                                  fileInput.current?.click();
                                }}
                              >
                                {t('library.resume')}
                              </Button>
                            )}
                          {canManage &&
                            item.state !== 'RECEIVING' &&
                            item.state !== 'VERIFYING' && (
                              <Button variant="secondary" onClick={() => setRenaming(item)}>
                                {t('library.rename')}
                              </Button>
                            )}
                          {canManage && (
                            <Button variant="quiet" onClick={() => setRemoving(item)}>
                              {t('library.remove')}
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {renaming && (
        <RenameForm
          item={renaming}
          parsed={friendly({ filename: renaming.filename })}
          onCancel={() => setRenaming(null)}
          onSave={(title, language) => void saveRename(renaming, title, language)}
        />
      )}

      {removing && (
        <Card title={t('library.removeTitle', { filename: removing.filename })}>
          <p className="text-sm text-ink">{t('library.removeBody')}</p>
          <div className="mt-3 flex gap-2">
            <Button variant="quiet" onClick={() => void remove(removing)}>
              {t('library.removeConfirm')}
            </Button>
            <Button variant="secondary" onClick={() => setRemoving(null)}>
              {t('common.cancel')}
            </Button>
          </div>
        </Card>
      )}

      {pushing && (
        <PushDialog
          item={pushing}
          onClose={() => setPushing(null)}
          onQueued={(jobId) => {
            setPushing(null);
            setNotice({ jobId, text: t('library.pushQueued', { filename: pushing.filename }) });
          }}
        />
      )}
    </div>
  );
}

function RenameForm({
  item,
  parsed,
  onCancel,
  onSave,
}: {
  item: LibraryItemSummary;
  parsed: { title: string; language: string | null };
  onCancel: () => void;
  onSave: (title: string, language: string | null) => void;
}) {
  const t = useTranslations();
  const [title, setTitle] = useState(item.titleOverride ?? '');
  const [language, setLanguage] = useState(item.languageOverride ?? '');
  const [keepParsedLanguage, setKeepParsedLanguage] = useState(item.languageOverride === null);

  return (
    <Card
      title={t('library.renameTitle')}
      description={t('library.renameDescription', { filename: item.filename })}
    >
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          onSave(title, keepParsedLanguage ? null : language.trim());
        }}
      >
        <Field
          label={t('library.renameName')}
          hint={t('library.renameNameHint', { parsed: parsed.title })}
        >
          {(props) => (
            <TextInput
              {...props}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={parsed.title}
            />
          )}
        </Field>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={keepParsedLanguage}
            onChange={(event) => setKeepParsedLanguage(event.target.checked)}
          />
          {t('library.renameKeepLanguage', {
            language: parsed.language ?? t('library.noLanguage'),
          })}
        </label>
        {!keepParsedLanguage && (
          <Field label={t('library.renameLanguage')} hint={t('library.renameLanguageHint')}>
            {(props) => (
              <TextInput
                {...props}
                value={language}
                onChange={(event) => setLanguage(event.target.value)}
                placeholder="nl, en-GB, de"
              />
            )}
          </Field>
        )}
        <div className="flex gap-2">
          <Button type="submit">{t('common.save')}</Button>
          <Button variant="secondary" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

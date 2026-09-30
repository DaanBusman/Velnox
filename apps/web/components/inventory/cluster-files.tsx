'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import type { ClusterFile, ClusterFilesResponse } from '@velnox/shared';
import { apiPost, type ApiFailure } from '@/lib/client-api';
import { useApiError } from '@/lib/use-api-error';
import { Button, FormError } from '@/components/ui/form';
import { Card, Notice, StatusBadge } from '@/components/ui/primitives';
import { FriendlyName } from '@/components/library/friendly-name';

const size = (value: number | null, format: ReturnType<typeof useFormatter>): string =>
  value === null ? '—' : `${format.number(value / 1024 ** 3, { maximumFractionDigits: 2 })} GB`;

/**
 * ISOs and disk images on one cluster, as discovery last saw them.
 *
 * Deleting is a job, and asks first: the file is on somebody's infrastructure.
 * Copying into the library needs SSH on the cluster, because Proxmox's API has
 * no call to read a file back — without it the button explains that rather
 * than failing.
 */
export function ClusterFiles({
  clusterId,
  files,
  canManage,
  canPull,
}: {
  clusterId: string;
  files: ClusterFilesResponse | null;
  canManage: boolean;
  canPull: boolean;
}) {
  const t = useTranslations();
  const format = useFormatter();
  const router = useRouter();
  const describeError = useApiError();
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [confirming, setConfirming] = useState<ClusterFile | null>(null);
  const [queued, setQueued] = useState<{ jobId: string; text: string } | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  if (!files) return <Notice tone="error">{t('errors.generic')}</Notice>;

  async function act(file: ClusterFile, action: 'pull' | 'delete') {
    setPending(`${action}:${file.id}`);
    setFailure(null);
    const result = await apiPost<{ id?: string; job?: { id: string } }>(
      `/clusters/${clusterId}/files/${action}`,
      {
        node: file.node,
        storage: file.storage,
        volid: file.volid,
      },
    );
    setPending(null);
    setConfirming(null);
    if (!result.ok) return setFailure(result.error);
    const jobId = result.data.job?.id ?? result.data.id ?? '';
    setQueued({
      jobId,
      text:
        action === 'pull'
          ? t('clusters.files.pullQueued', { filename: file.filename })
          : t('clusters.files.deleteQueued', { filename: file.filename }),
    });
    router.refresh();
  }

  return (
    <Card title={t('clusters.files.title')} description={t('clusters.files.description')}>
      <div className="space-y-3">
        {failure && <FormError>{describeError(failure)}</FormError>}
        {queued && (
          <Notice tone="neutral">
            {queued.text}{' '}
            {queued.jobId && (
              <Link className="text-accent underline" href={`/jobs/${queued.jobId}`}>
                {t('library.followJob')}
              </Link>
            )}
          </Notice>
        )}
        {canPull && !files.sshConfigured && (
          <p className="text-xs text-ink-muted">{t('clusters.files.pullNeedsSsh')}</p>
        )}

        {files.contents.length === 0 ? (
          <p className="text-sm text-ink-muted">{t('clusters.files.empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-ink-muted">
                  <th scope="col" className="py-1.5 pr-4 font-medium">
                    {t('library.name')}
                  </th>
                  <th scope="col" className="py-1.5 pr-4 font-medium">
                    {t('clusters.files.where')}
                  </th>
                  <th scope="col" className="py-1.5 pr-4 text-right font-medium">
                    {t('library.size')}
                  </th>
                  <th scope="col" className="py-1.5 pr-4 font-medium">
                    {t('clusters.files.inLibrary')}
                  </th>
                  <th scope="col" className="py-1.5 font-medium">
                    <span className="sr-only">{t('library.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {files.contents.map((file) => (
                  <tr key={file.id} className="border-b border-line align-top last:border-b-0">
                    <td className="py-2 pr-4">
                      <FriendlyName item={{ filename: file.filename }} />
                      <div className="font-mono text-xs text-ink-muted">{file.volid}</div>
                    </td>
                    <td className="py-2 pr-4 text-xs text-ink-muted">
                      {file.shared
                        ? t('clusters.files.shared', { storage: file.storage })
                        : `${file.node} · ${file.storage}`}
                    </td>
                    <td className="py-2 pr-4 text-right font-mono text-xs tabular-nums">
                      {size(file.sizeBytes, format)}
                    </td>
                    <td className="py-2 pr-4">
                      {file.libraryItemId ? (
                        <StatusBadge tone="ok">{t('clusters.files.yes')}</StatusBadge>
                      ) : (
                        <StatusBadge tone="neutral">{t('clusters.files.no')}</StatusBadge>
                      )}
                    </td>
                    <td className="py-2 text-right whitespace-nowrap">
                      {confirming?.id === file.id ? (
                        <span className="inline-flex items-center gap-2">
                          <span className="text-xs text-ink">
                            {t('clusters.files.confirmDelete')}
                          </span>
                          <Button
                            variant="secondary"
                            pending={pending === `delete:${file.id}`}
                            onClick={() => void act(file, 'delete')}
                          >
                            {t('clusters.files.delete')}
                          </Button>
                          <Button variant="quiet" onClick={() => setConfirming(null)}>
                            {t('common.cancel')}
                          </Button>
                        </span>
                      ) : (
                        <span className="inline-flex gap-1">
                          {canPull && files.sshConfigured && !file.libraryItemId && (
                            <Button
                              variant="secondary"
                              pending={pending === `pull:${file.id}`}
                              onClick={() => void act(file, 'pull')}
                            >
                              {t('clusters.files.pull')}
                            </Button>
                          )}
                          {canManage && (
                            <Button variant="quiet" onClick={() => setConfirming(file)}>
                              {t('clusters.files.delete')}
                            </Button>
                          )}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}

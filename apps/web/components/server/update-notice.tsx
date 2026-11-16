'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import clsx from 'clsx';
import type { UpdateStatusResponse } from '@velnox/shared';
import { apiGet } from '@/lib/client-api';
import { UPDATE_STATUS_EVENT } from './update-check-card';

/** Opens Server management on a tab. The window listens for it. */
export const OPEN_SERVER_MANAGEMENT_EVENT = 'velnox:open-server-management';

/** How often the notice reads the status again while a tab stays open. */
const REREAD_MS = 60 * 60_000;

/**
 * Above Server management in the sidebar: "Update 0.7.22", or "Critical update" in
 * the error colour when an advisory that concerns this installation is
 * critical (0.7.21). Nothing when there is nothing newer, when the check is
 * off, and when it could not ask — a missing internet connection is Server
 * management's to explain, not the sidebar's to shout about.
 *
 * Rendered for system.manage only: the endpoint is refused without it.
 */
export function UpdateNotice() {
  const t = useTranslations();
  const [status, setStatus] = useState<UpdateStatusResponse | null>(null);

  useEffect(() => {
    let live = true;
    const read = () =>
      void apiGet<UpdateStatusResponse>('/system/update').then((response) => {
        if (live && response.ok) setStatus(response.data);
      });
    read();
    const timer = window.setInterval(read, REREAD_MS);
    const changed = (event: Event) => setStatus((event as CustomEvent<UpdateStatusResponse>).detail);
    window.addEventListener(UPDATE_STATUS_EVENT, changed);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener(UPDATE_STATUS_EVENT, changed);
    };
  }, []);

  if (!status?.enabled || !status.updateAvailable || !status.latest) return null;

  return (
    <button
      type="button"
      data-update-notice={status.critical ? 'critical' : 'available'}
      onClick={() =>
        window.dispatchEvent(new CustomEvent(OPEN_SERVER_MANAGEMENT_EVENT, { detail: { tab: 'updates' } }))
      }
      title={t('server.updateCheck.noticeTitle', { version: status.latest })}
      className={clsx(
        'mb-1.5 flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs font-medium ring-1 ring-inset transition-colors',
        status.critical
          ? 'bg-error-bg text-error ring-error/30 hover:ring-error/60'
          : 'bg-accent-soft text-accent ring-accent/30 hover:ring-accent/60',
      )}
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />
      {t(status.critical ? 'server.updateCheck.noticeCritical' : 'server.updateCheck.notice', {
        version: status.latest,
      })}
    </button>
  );
}

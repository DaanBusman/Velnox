'use client';

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { InterfaceSettings } from '@/components/interface-settings';

export interface ViewerPreferences {
  locale: string;
  refreshSeconds: number;
  refreshChoices: readonly number[];
  motionBackground: boolean;
  timeZone: string | null;
  installationTimeZone: string;
}

/**
 * Personal preferences, in a window over the page — opened from the account
 * menu, as the owner asked, rather than as a page in the sidebar: they belong
 * to the person, not to the installation.
 *
 * A native `<dialog>` opened with `showModal()`: the browser makes the rest of
 * the page inert, keeps focus inside, closes it on Escape and draws the
 * backdrop, so none of that is hand-rolled. Each preference applies the moment
 * it changes (see InterfaceSettings), so closing it is all there is to do.
 *
 * `m-auto` is what centres it: the browser centres a modal dialog with
 * `margin: auto`, and Tailwind's reset sets every margin to 0 — which put it
 * in the top-left corner.
 */
export function PreferencesDialog({
  open,
  onClose,
  preferences,
}: {
  open: boolean;
  onClose: () => void;
  preferences: ViewerPreferences;
}) {
  const t = useTranslations();
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby="preferences-title"
      onClose={onClose}
      // A click on the backdrop is a click on the dialog element itself.
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      className="m-auto w-[min(40rem,calc(100vw-2rem))] max-h-[calc(100dvh-4rem)] overflow-y-auto rounded-lg border border-line bg-surface p-0 text-ink shadow-2xl backdrop:bg-black/50 backdrop:backdrop-blur-[2px]"
    >
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <h2 id="preferences-title" className="text-sm font-semibold tracking-tight">
          {t('settings.title')}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close')}
          className="grid size-7 place-items-center rounded text-ink-muted hover:bg-surface-2 hover:text-ink focus:outline-none focus:ring-2 focus:ring-accent/40"
        >
          <span aria-hidden>×</span>
        </button>
      </div>
      <div className="p-5">{open && <InterfaceSettings {...preferences} />}</div>
    </dialog>
  );
}

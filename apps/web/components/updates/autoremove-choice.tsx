'use client';

import { useTranslations } from 'next-intl';

/**
 * End the update with `apt-get autoremove`. Under a window that has it on it
 * is on and cannot be turned off here: the window decides for every update in
 * it, and the request only adds.
 */
export function AutoremoveChoice({
  checked,
  byWindow,
  onChange,
}: {
  checked: boolean;
  byWindow: boolean;
  onChange: (value: boolean) => void;
}) {
  const t = useTranslations();
  return (
    <div className="space-y-1">
      <label
        className={`flex items-center gap-2 text-sm text-ink ${byWindow ? 'cursor-not-allowed opacity-60' : ''}`}
      >
        <input
          type="checkbox"
          checked={checked}
          disabled={byWindow}
          onChange={(e) => onChange(e.target.checked)}
        />
        {t('nodeUpdates.autoremove')}
      </label>
      <p className="text-xs text-ink-muted">
        {byWindow ? t('nodeUpdates.autoremoveByWindow') : t('nodeUpdates.autoremoveHint')}
      </p>
    </div>
  );
}

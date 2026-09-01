'use client';

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { useTranslations } from 'next-intl';

export function ThemeToggle() {
  const t = useTranslations();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // The server cannot know the viewer's system theme, so rendering the current
  // value before hydration would produce a mismatch. Render the control inert
  // until mounted rather than guessing.
  useEffect(() => setMounted(true), []);

  return (
    <label className="flex items-center gap-1.5">
      <span className="sr-only">{t('layout.theme')}</span>
      <select
        value={mounted ? (theme ?? 'system') : 'system'}
        disabled={!mounted}
        onChange={(event) => setTheme(event.target.value)}
        className="h-7 rounded border border-line bg-surface-2 px-1.5 text-xs text-ink disabled:opacity-60"
        aria-label={t('layout.theme')}
      >
        <option value="light">{t('layout.themeLight')}</option>
        <option value="dark">{t('layout.themeDark')}</option>
        <option value="system">{t('layout.themeSystem')}</option>
      </select>
    </label>
  );
}

'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

/**
 * A value to carry into another system, shown rather than asked for.
 *
 * Anything Velnox already knows — the redirect URI, the app registration name —
 * is displayed here to be copied. Retyping a redirect URI is how installations
 * end up with one that differs by a trailing slash, which Entra rejects with an
 * error that does not say which character is wrong.
 *
 * The text is selectable regardless of whether the clipboard works, because a
 * browser may refuse clipboard access and the value still has to be reachable.
 */
export function CopyField({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  const t = useTranslations();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Refused. The value is on screen and selectable, so nothing is lost.
      setCopied(false);
    }
  }

  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-ink">{label}</p>
      <div className="flex items-stretch gap-2">
        <p className="min-w-0 flex-1 select-all break-all rounded border border-line bg-surface-2 px-2 py-1.5 font-mono text-xs text-ink">
          {value}
        </p>
        <button
          type="button"
          onClick={copy}
          className="shrink-0 rounded border border-line bg-surface px-2.5 text-xs font-medium text-ink hover:bg-surface-2 focus:outline-none focus:ring-2 focus:ring-accent/40"
        >
          {copied ? t('mfa.copied') : t('mfa.copy')}
        </button>
      </div>
      {hint && <p className="text-xs text-ink-muted">{hint}</p>}
    </div>
  );
}

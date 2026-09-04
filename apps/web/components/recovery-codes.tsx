'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/form';
import { Notice } from '@/components/ui/primitives';

/**
 * Recovery codes, shown once.
 *
 * They are never retrievable again — the server keeps only Argon2id hashes — so
 * this screen has one job: make sure the user actually saves them before it
 * disappears. Hence the explicit acknowledgement rather than a button that
 * dismisses on the way past.
 *
 * Copy and download are conveniences, and both are best-effort: a clipboard
 * write can be refused by the browser, and neither is the thing being relied on.
 * The codes are on screen and selectable, which always works.
 */
export function RecoveryCodes({
  codes,
  onAcknowledge,
  title,
}: {
  codes: string[];
  onAcknowledge: () => void;
  title?: string;
}) {
  const t = useTranslations();
  const [acknowledged, setAcknowledged] = useState(false);
  const [copied, setCopied] = useState(false);

  const asText = codes.join('\n');

  async function copy() {
    try {
      await navigator.clipboard.writeText(asText);
      setCopied(true);
    } catch {
      // Clipboard access can be refused outright. The codes are selectable on
      // screen, so this is a convenience failing, not the user losing anything.
      setCopied(false);
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([`${asText}\n`], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'velnox-recovery-codes.txt';
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="rounded border border-line bg-surface p-6 shadow-[0_1px_2px_rgba(16,21,28,0.04)]">
      <h1 className="text-base font-semibold text-ink">{title ?? t('mfa.recoveryTitle')}</h1>
      <p className="mt-1 text-sm text-ink-muted">{t('mfa.recoveryBody')}</p>

      <ul className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1.5 rounded border border-line bg-surface-2 p-3 font-mono text-sm text-ink">
        {codes.map((code) => (
          <li key={code} className="select-all">
            {code}
          </li>
        ))}
      </ul>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" variant="secondary" onClick={copy}>
          {copied ? t('mfa.copied') : t('mfa.copy')}
        </Button>
        <Button type="button" variant="secondary" onClick={download}>
          {t('mfa.download')}
        </Button>
      </div>

      <div className="mt-4">
        <Notice tone="warn" title={t('mfa.recoveryWarningTitle')}>
          {t('mfa.recoveryWarning')}
        </Notice>
      </div>

      <label className="mt-4 flex items-start gap-2 text-sm text-ink">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
          className="mt-0.5 size-4 rounded border-line accent-[var(--velnox-accent)]"
        />
        <span>{t('mfa.recoveryAcknowledge')}</span>
      </label>

      <Button
        type="button"
        onClick={onAcknowledge}
        disabled={!acknowledged}
        className="mt-4 w-full"
      >
        {t('mfa.continue')}
      </Button>
    </div>
  );
}

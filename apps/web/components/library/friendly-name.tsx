'use client';

import { useMemo } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { parseFriendlyName } from '@velnox/shared';

export interface Named {
  filename: string;
  titleOverride?: string | null;
  languageOverride?: string | null;
}

export interface FriendlyLabel {
  title: string;
  /** The language, named in the reader's language: "Dutch" or "Nederlands". */
  language: string | null;
  variants: string[];
  arch: string | null;
  /** False when nothing was recognised and nobody corrected it. */
  recognised: boolean;
}

/**
 * A library filename as a person reads it.
 *
 * `Windows11_25H2_Dutch.iso` becomes "Windows 11 Version 25H2" and "Dutch" —
 * or "Nederlands", for a reader whose Velnox speaks Dutch, because the language
 * is kept as a tag and named by the browser in the reader's own language rather
 * than stored as a word. An operator's correction replaces the parsed title or
 * language; the filename itself never changes, because it is what Proxmox
 * calls the file.
 */
export function useFriendlyName(): (item: Named) => FriendlyLabel {
  const t = useTranslations();
  const locale = useLocale();
  const languages = useMemo(() => {
    try {
      return new Intl.DisplayNames([locale], { type: 'language' });
    } catch {
      return null;
    }
  }, [locale]);

  return (item) => {
    const parsed = parseFriendlyName(item.filename);
    const tag =
      item.languageOverride === null || item.languageOverride === undefined
        ? parsed.language
        : item.languageOverride || null;

    let language: string | null = null;
    if (tag) {
      try {
        language = languages?.of(tag) ?? tag;
      } catch {
        language = tag;
      }
    }

    return {
      title: item.titleOverride || parsed.title,
      language,
      variants: parsed.variants.map((variant) => t(`library.variant.${variant}`)),
      arch: parsed.arch,
      recognised: parsed.recognised || Boolean(item.titleOverride),
    };
  };
}

/** The whole label on one line, for places with no room for two. */
export function FriendlyName({ item }: { item: Named }) {
  const t = useTranslations();
  const label = useFriendlyName()(item);
  return (
    <span>
      <span className="font-medium text-ink">{label.title}</span>
      {label.language && <span className="text-ink"> {label.language}</span>}
      {label.variants.length > 0 && (
        <span className="text-ink-muted"> · {label.variants.join(', ')}</span>
      )}
      {!label.recognised && (
        <span className="ml-2 text-[11px] uppercase tracking-wide text-ink-muted">
          {t('library.notRecognised')}
        </span>
      )}
    </span>
  );
}

'use client';

import { useTranslations } from 'next-intl';
import type { ApiFailure } from './client-api';

/**
 * Turns an API error code into a sentence in the reader's language.
 *
 * The API returns codes, never prose (docs/tech-decisions.md ADR-019), so this
 * is the single place where a code becomes something a person reads. An unknown
 * code falls back to the generic message rather than rendering the raw code:
 * `auth.mfa_invalid` on screen is a bug report, not an explanation.
 */
export function useApiError(): (failure: ApiFailure | null | undefined) => string | null {
  const t = useTranslations();

  return (failure) => {
    if (!failure) return null;

    const key = `errors.${failure.code}`;
    if (t.has(key)) {
      return t(key, failure.params as Record<string, never> | undefined);
    }

    return t('errors.generic');
  };
}

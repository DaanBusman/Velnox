'use client';

import { useTranslations } from 'next-intl';
import { Notice } from '@/components/ui/primitives';
import { useApiError } from '@/lib/use-api-error';
import type { ApiFailure } from '@/lib/client-api';

/**
 * What a panel shows while it has nothing to show.
 *
 * Shared so the three panels cannot drift into three different ideas of what a
 * failure looks like — and so "you do not have permission" is distinguished from
 * "something went wrong", which are different problems with different answers.
 */

export function PanelLoading() {
  const t = useTranslations();
  return (
    <div className="space-y-3" aria-busy="true" aria-live="polite">
      <span className="sr-only">{t('common.loading')}</span>
      {/* Three plausible rows rather than a spinner: the panel keeps its shape,
          so nothing jumps when the data lands. */}
      {[0, 1, 2].map((row) => (
        <div
          key={row}
          className="h-16 animate-pulse rounded-md border border-line bg-surface-2"
          style={{ animationDelay: `${row * 90}ms` }}
        />
      ))}
    </div>
  );
}

export function PanelError({ error }: { error: ApiFailure }) {
  const t = useTranslations();
  const describe = useApiError();

  if (error.code === 'authz.forbidden') {
    return (
      <Notice tone="warn" title={t('server.forbiddenTitle')}>
        {t('common.requiresPermission', { permission: 'system.manage' })}
      </Notice>
    );
  }

  return (
    <Notice tone="error" title={t('errors.generic')}>
      {describe(error) ?? t('errors.generic')}
    </Notice>
  );
}

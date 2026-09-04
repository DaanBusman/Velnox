import { getTranslations } from 'next-intl/server';
import { Notice } from '@/components/ui/primitives';
import { DOCS_VERSION } from '@/lib/docs';
import { tryGetSystemInfo } from '@/lib/api';

/**
 * "This documentation applies to version V0.2.0", on every documentation page.
 *
 * The version comes from the bundle, which was stamped by the same build that
 * produced the pages — so this is a statement about what the reader is looking
 * at, not a hopeful label.
 *
 * It also compares itself against the version the API reports. Those agree in
 * any normal installation, because both come out of one build. They can disagree
 * when an upgrade has replaced one container and not the other, which is exactly
 * the situation where someone is reading the documentation to work out what is
 * wrong — so it is said out loud instead of being left to be discovered.
 */
export async function DocVersionBanner() {
  const [t, info] = await Promise.all([getTranslations(), tryGetSystemInfo()]);

  const runningVersion = info?.version ?? null;
  const mismatch = runningVersion !== null && runningVersion !== DOCS_VERSION;

  if (mismatch) {
    return (
      <Notice tone="warn" title={t('docs.versionMismatchTitle')}>
        {t('docs.versionMismatchBody', { docs: DOCS_VERSION, running: runningVersion })}
      </Notice>
    );
  }

  return (
    <p className="text-xs text-ink-muted">{t('docs.appliesToVersion', { version: DOCS_VERSION })}</p>
  );
}

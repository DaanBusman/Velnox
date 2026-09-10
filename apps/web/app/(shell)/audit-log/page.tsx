import { getTranslations } from 'next-intl/server';
import { AuditPanel } from '@/components/server/audit-panel';
import { PageHeader } from '@/components/ui/primitives';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('nav.auditLog') };
}

/**
 * The audit log, as a page.
 *
 * The audit trail moved into Server management, which is where the rest of the
 * installation's own administration now lives. This page did not go with it,
 * because Server management needs `system.manage` and the audit log needs
 * `audit.read` — and those are not the same people. MSP Read Only exists to
 * review what happened and holds no management permission at all; moving the
 * audit log behind an administrator's window would have taken it away from the
 * one role whose entire purpose is reading it.
 *
 * So the sidebar shows this entry to whoever holds `audit.read` *without*
 * `system.manage`, and Server management carries the same panel for everyone
 * else. One implementation, rendered in two places — the alternative was two
 * audit tables drifting apart, and the one that drifts is the one nobody is
 * looking at.
 */
export default async function AuditLogPage() {
  const t = await getTranslations();

  return (
    <>
      <PageHeader title={t('nav.auditLog')} description={t('audit.subtitle')} />
      <AuditPanel />
    </>
  );
}

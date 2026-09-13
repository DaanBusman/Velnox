import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { SessionKeepAlive } from '@/components/session-keepalive';
import { SessionRecovery } from '@/components/session-recovery';
import { Sidebar } from '@/components/sidebar';
import { Topbar } from '@/components/topbar';
import { tryGetSystemInfo } from '@/lib/api';
import { getSession, getSetupStatus, listTenants } from '@/lib/session';
import { resolveSelection, selectedTenantId } from '@/lib/tenant-selection';

/**
 * The signed-in application.
 *
 * Every page under this group is behind the gate below. Putting it in the layout
 * rather than in each page means a new page is protected by having been placed
 * here — there is no per-page check to forget.
 *
 * The API enforces the same rules independently. This is the redirect that makes
 * the product usable; it is not what makes it secure.
 */
export default async function ShellLayout({ children }: { children: React.ReactNode }) {
  const [setup, session] = await Promise.all([getSetupStatus(), getSession()]);

  // A fresh installation has no accounts at all, so there is nothing to sign
  // in to yet.
  if (setup && !setup.initialized) redirect('/setup');

  /*
   * No session, as far as the server can tell.
   *
   * That covers two very different situations. Either there is genuinely no
   * session, or the access token expired while a perfectly good refresh token
   * sits in the browser — which the server never sees, because that cookie is
   * scoped to /api/v1/auth. Redirecting immediately would sign people out every
   * fifteen minutes.
   *
   * So the browser is asked to try the exchange first, and only lands on the
   * sign-in form when it fails.
   */
  if (!session) return <SessionRecovery />;

  // The session exists but still owes a second factor. The API would refuse
  // every request this page makes; sending the user somewhere they can actually
  // finish is the only useful thing to do.
  if (!session.mfaSatisfied) redirect('/mfa');

  const [locale, t, info, tenants, selected] = await Promise.all([
    getLocale(),
    getTranslations(),
    tryGetSystemInfo(),
    /*
     * The tenant list drives the selector in the top bar, and it is read here
     * rather than per page so the selection is the same on all of them.
     *
     * A failure is not fatal: someone without `tenants.read` gets a 403, which
     * is a perfectly ordinary state for a customer's own operator. The selector
     * simply does not appear.
     */
    listTenants(),
    selectedTenantId(),
  ]);

  const selectableTenants = tenants.ok ? tenants.data.tenants : [];

  // Read from the installation, not hardcoded, so rebranding is a settings
  // change (docs/architecture.md section 15).
  const product = info?.product ?? 'Velnox';
  const version = info?.version ?? '';

  return (
    <>
      <SessionKeepAlive />

      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-accent focus:px-3 focus:py-1.5 focus:text-xs focus:text-accent-contrast"
      >
        {t('layout.skipToContent')}
      </a>

      <div className="flex h-dvh overflow-hidden">
        <Sidebar
          product={product}
          version={version}
          // The sidebar hides what this account cannot use — a courtesy, not the
          // control. The API refuses every one of these regardless.
          permissions={session.user.permissions}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar
            locale={locale}
            user={session.user}
            tenants={selectableTenants}
            selectedTenantId={resolveSelection(selected, selectableTenants)}
          />

          <main id="main" className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-6xl px-6 py-6">{children}</div>

            <footer className="mx-auto max-w-6xl px-6 pb-6 text-xs text-ink-muted">
              {t('layout.footerLicense', { product, version })}{' '}
              <a href="/settings/about" className="underline underline-offset-2">
                {t('layout.footerSource')}
              </a>
            </footer>
          </main>
        </div>
      </div>
    </>
  );
}

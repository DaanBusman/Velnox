import en from '@velnox/i18n/locales/en.json';
import nl from '@velnox/i18n/locales/nl.json';
import { serviceWorkerSource, type OfflineText } from '@/lib/pwa/service-worker';

export const dynamic = 'force-dynamic';

const offline = (lang: string, catalogue: typeof en): OfflineText => ({
  lang,
  title: catalogue.pwa.offlineTitle,
  body: catalogue.pwa.offlineBody,
  retry: catalogue.pwa.offlineRetry,
});

/**
 * The service worker, at the root so its scope is the whole interface
 * (ADR-058). Served without a session — the browser fetches it on its own —
 * and never cached, so a new build is picked up on the next check.
 */
export function GET(): Response {
  const build = `${process.env.VELNOX_VERSION ?? 'dev'}-${process.env.VELNOX_BUILD_COMMIT ?? 'local'}`;
  return new Response(serviceWorkerSource(build, [offline('en', en), offline('nl', nl)]), {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  });
}

import type { MetadataRoute } from 'next';
import { getTranslations } from 'next-intl/server';
import { tryGetSystemInfo } from '@/lib/api';
import icon192 from '@/assets/pwa/icon-192.png';
import icon512 from '@/assets/pwa/icon-512.png';
import maskable512 from '@/assets/pwa/maskable-512.png';

export const dynamic = 'force-dynamic';

/**
 * What a browser needs to offer Velnox as an app (ADR-058): its name, a window
 * of its own, and icons. The icons are imported, so they are served from
 * `/_next/static/media` — in the standalone image, and cached by the service
 * worker like any other static file.
 */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const [info, t] = await Promise.all([tryGetSystemInfo(), getTranslations('pwa')]);
  const name = info?.product ?? 'Velnox';
  return {
    id: '/',
    name,
    short_name: name,
    description: t('description'),
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#0a0e13',
    theme_color: '#0a0e13',
    icons: [
      { src: icon192.src, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: icon512.src, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: maskable512.src, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}

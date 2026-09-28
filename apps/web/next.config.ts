import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import { join } from 'node:path';

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

/**
 * Standalone output produces a self-contained server bundle, which keeps the
 * runtime image small and makes the air-gapped artifact viable
 * (docs/tech-decisions.md ADR-018).
 *
 * It is opt-in rather than always on because tracing creates symlinks, and
 * Windows refuses that without Developer Mode or elevation — so a developer on
 * Windows could not build the app at all. The Dockerfile sets this flag; the
 * image that ships is always the standalone one.
 */
const standalone = process.env.VELNOX_STANDALONE === '1';

const nextConfig: NextConfig = {
  ...(standalone ? { output: 'standalone' as const } : {}),
  // In a pnpm workspace the tracer must start at the repository root or it misses
  // the linked @velnox/* packages.
  outputFileTracingRoot: join(process.cwd(), '..', '..'),
  transpilePackages: ['@velnox/shared', '@velnox/i18n'],
  reactStrictMode: true,
  // No `eslint` key: Next 16 removed it along with linting inside `next build`.
  // Linting runs as its own workspace task, which is what that key existed to
  // arrange.
  poweredByHeader: false,
};

export default withNextIntl(nextConfig);

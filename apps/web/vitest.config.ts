import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Vitest needs the `@/` alias spelled out.
 *
 * Next.js and TypeScript both read it from tsconfig.json's `paths`, but Vitest
 * does not, so a test importing `@/lib/docs` failed to resolve and the file was
 * reported as "no tests" — which passes a suite while running nothing.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
});

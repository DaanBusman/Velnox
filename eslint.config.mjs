// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * Velnox lint configuration.
 *
 * Beyond ordinary code quality, this file mechanically enforces two rules that
 * docs/architecture.md relies on for security. They are here, not in a review
 * checklist, because a review checklist does not fail a build.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/generated/**',
      '**/next-env.d.ts',
      'packages/db/prisma/migrations/**',
    ],
  },

  eslint.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],

      'no-restricted-syntax': [
        'error',
        {
          // docs/architecture.md section 4, layer 2: raw SQL bypasses the Prisma
          // tenancy extension, so a forgotten tenant filter would leak across
          // tenants. Allowlisted call sites must disable this rule inline with a
          // comment explaining why the query is safe.
          selector:
            'MemberExpression[property.name=/^\\$(queryRaw|queryRawUnsafe|executeRaw|executeRawUnsafe)$/]',
          message:
            'Raw SQL bypasses the Prisma tenancy extension and can leak across tenants. Use the typed client. If this query genuinely cannot be expressed otherwise, disable this rule inline and explain how tenant scoping is enforced.',
        },
        {
          // docs/architecture.md section 8: Velnox pins certificate fingerprints.
          // There is deliberately no insecure TLS mode anywhere in the codebase.
          selector: 'Property[key.name="rejectUnauthorized"][value.value=false]',
          message:
            'Disabling TLS verification is not permitted. Velnox pins the certificate fingerprint per endpoint (tls_verify_mode) or uses a supplied CA bundle.',
        },
      ],
    },
  },

  {
    // NestJS resolves constructor dependencies from the runtime type metadata
    // that `emitDecoratorMetadata` produces. `import type` erases the class, so
    // the metadata becomes `undefined` and injection fails at runtime — with an
    // error that points at the module, not at the import. The rule's autofix
    // introduces exactly that bug, so it is off wherever DI is in play.
    files: ['apps/api/**/*.ts', 'apps/worker/**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },

  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },

  {
    files: ['**/*.spec.ts', '**/*.test.ts', 'scripts/**/*.mjs'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  prettier,
);

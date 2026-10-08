// @ts-check
// Root ESLint flat config for the whole monorepo.
// Custom restrictions (time and money) are exported so tools/repo-checks can prove they fire.
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettierConfig from 'eslint-config-prettier';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Server code must get time only from the injected Clock (apps/server/src/lib/clock.ts).
 * @type {Array<{ selector: string, message: string }>}
 */
export const timeRestrictions = [
  {
    selector:
      "CallExpression[callee.type='MemberExpression'][callee.object.name='Date'][callee.property.name='now']",
    message:
      'Date.now() is forbidden in server code. Use the injected Clock (apps/server/src/lib/clock.ts).',
  },
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message: 'new Date() without arguments is forbidden in server code. Use the injected Clock.',
  },
  {
    selector: "CallExpression[callee.name='Date']",
    message:
      'Date() returns the current time; it is forbidden in server code. Use the injected Clock.',
  },
];

/**
 * Money is bigint in minimal units only (µCR, µUSD, KRW). No floating point anywhere near it.
 * @type {Array<{ selector: string, message: string }>}
 */
export const moneyRestrictions = [
  {
    selector: "CallExpression[callee.name='parseFloat']",
    message: 'parseFloat is forbidden in money code. Use bigint minimal units.',
  },
  {
    selector: "CallExpression[callee.name='Number'], NewExpression[callee.name='Number']",
    message: 'Number(...) is forbidden in money code. Use bigint minimal units.',
  },
  {
    selector: "MemberExpression[object.name='Number'][property.name=/^parse(Float|Int)$/]",
    message: 'Number.parseFloat/parseInt is forbidden in money code. Use BigInt parsing helpers.',
  },
  {
    selector: "MemberExpression[object.name='Math']",
    message:
      'Math.* (round, floor, ...) is forbidden in money code. Money is bigint; rounding must be explicit integer arithmetic.',
  },
  {
    selector: "MemberExpression[property.name='toFixed']",
    message: 'toFixed is forbidden in money code. Format bigint minimal units explicitly.',
  },
  {
    // Decimal-point or exponent number literals (1.5, .5, 1., 1e6). Hex/binary/octal and bigint literals do not match.
    selector:
      'Literal[raw=/^(?:[0-9][0-9_]*)?\\.[0-9_]*(?:[eE][+-]?[0-9_]+)?$|^[0-9][0-9_]*[eE][+-]?[0-9_]+$/]',
    message:
      'Floating-point literals are forbidden in money code. Use bigint minimal units (e.g. 1_500_000n µCR).',
  },
];

/** Paths treated as money code anywhere in the repo. */
export const moneyFiles = [
  '**/money/**/*.{ts,tsx,mts,cts,js,mjs}',
  '**/ledger/**/*.{ts,tsx,mts,cts,js,mjs}',
  '**/pricing/**/*.{ts,tsx,mts,cts,js,mjs}',
];
/** Server source files subject to the clock rule. */
export const serverFiles = ['apps/server/src/**/*.{ts,mts,cts,js,mjs}'];
/** The single place allowed to read the wall clock. */
export const clockFile = 'apps/server/src/lib/clock.ts';
/** Server money paths: both restriction sets must apply (flat config replaces, not merges, rule options). */
export const serverMoneyFiles = [
  'apps/server/src/**/money/**/*.{ts,mts,cts,js,mjs}',
  'apps/server/src/**/ledger/**/*.{ts,mts,cts,js,mjs}',
  'apps/server/src/**/pricing/**/*.{ts,mts,cts,js,mjs}',
];

export default defineConfig(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.next/**',
      '.runner/**',
      'apps/agent/**',
      // Kit tools: dependency-free, must not be modified (prompts/S00_bootstrap.md §3).
      'scripts/board.mjs',
      'scripts/status.mjs',
    ],
  },
  { linterOptions: { reportUnusedDisableDirectives: 'error' } },

  // JavaScript (scripts, config files): non type-aware recommended rules.
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [js.configs.recommended],
    languageOptions: { globals: { ...globals.node }, ecmaVersion: 2023, sourceType: 'module' },
  },

  // TypeScript: strict, type-aware.
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
    },
  },

  // Import order everywhere.
  {
    files: ['**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
    plugins: { 'simple-import-sort': simpleImportSort },
    rules: {
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
    },
  },

  // Custom restriction 1: money paths (anywhere).
  { files: moneyFiles, rules: { 'no-restricted-syntax': ['error', ...moneyRestrictions] } },
  // Custom restriction 2: server time (overrides 1 for server files, so server money paths are re-merged below).
  {
    files: serverFiles,
    ignores: [clockFile],
    rules: { 'no-restricted-syntax': ['error', ...timeRestrictions] },
  },
  // Custom restriction 3: server money paths get both sets.
  {
    files: serverMoneyFiles,
    ignores: [clockFile],
    rules: { 'no-restricted-syntax': ['error', ...timeRestrictions, ...moneyRestrictions] },
  },

  // Formatting is Prettier's job; turn off conflicting stylistic rules last.
  prettierConfig,
);

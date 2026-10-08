// @ts-check
// Root ESLint flat config for the whole monorepo.
// Custom restrictions (time and money) are exported so tools/repo-checks can prove they fire.
import js from '@eslint/js';
import eslintComments from '@eslint-community/eslint-plugin-eslint-comments';
import { defineConfig } from 'eslint/config';
import prettierConfig from 'eslint-config-prettier';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Server code must get time only from the injected Clock (apps/server/src/lib/clock.ts).
 * References are banned, not just calls, so `{ now: Date.now }` and `Date['now']` are caught too.
 * Monotonic timers (performance.now, process.hrtime) stay allowed: they measure durations, not wall-clock time.
 * @type {Array<{ selector: string, message: string }>}
 */
export const timeRestrictions = [
  {
    selector:
      "MemberExpression[object.name='Date'][property.name='now'], MemberExpression[object.name='Date'][property.value='now']",
    message:
      'Date.now is forbidden in server code. Use the injected Clock (apps/server/src/lib/clock.ts).',
  },
  {
    selector:
      "NewExpression[callee.name='Date'][arguments.length=0], NewExpression[callee.name='Date'] > SpreadElement",
    message:
      'new Date() without explicit arguments is forbidden in server code. Use the injected Clock.',
  },
  {
    selector: "CallExpression[callee.name='Date']",
    message:
      'Date() returns the current time; it is forbidden in server code. Use the injected Clock.',
  },
  {
    selector:
      "MemberExpression[object.name=/^(globalThis|window|global|self)$/][property.name='Date'], MemberExpression[object.name='Temporal'][property.name='Now']",
    message:
      'Reaching the clock through globalThis.Date or Temporal.Now is forbidden in server code. Use the injected Clock.',
  },
];

/**
 * Money is bigint in minimal units only (µCR, µUSD, KRW). No floating point anywhere near it.
 * Identifiers are banned (not only calls) so `.map(Number)`, `const { round } = Math` etc. are caught.
 * @type {Array<{ selector: string, message: string }>}
 */
export const moneyRestrictions = [
  {
    selector: 'Identifier[name=/^(parseFloat|parseInt|Number|Math|Infinity|NaN)$/]',
    message:
      'Number, Math, parseFloat/parseInt, Infinity and NaN are forbidden in money code. Use bigint minimal units.',
  },
  {
    selector: 'MemberExpression[object.name=/^(globalThis|window|global|self)$/]',
    message:
      'globalThis access is forbidden in money code (it bypasses the number/float restrictions).',
  },
  {
    selector:
      'MemberExpression[property.name=/^to(Fixed|Precision|Exponential)$/], MemberExpression[property.value=/^to(Fixed|Precision|Exponential)$/]',
    message:
      'toFixed/toPrecision/toExponential are forbidden in money code. Format bigint minimal units explicitly.',
  },
  {
    selector: "UnaryExpression[operator='+']",
    message:
      'Unary plus converts to a float number; forbidden in money code. Use BigInt parsing helpers.',
  },
  {
    // Decimal-point or exponent number literals (1.5, .5, 1., 1e6). Hex/binary/octal and bigint literals do not match.
    selector:
      'Literal[raw=/^(?:[0-9][0-9_]*)?\\.[0-9_]*(?:[eE][+-]?[0-9_]+)?$|^[0-9][0-9_]*[eE][+-]?[0-9_]+$/]',
    message:
      'Floating-point literals are forbidden in money code. Use bigint minimal units (e.g. 1_500_000n µCR).',
  },
];

const CODE_EXT = '{ts,tsx,mts,cts,js,jsx,mjs,cjs}';
/** Paths treated as money code anywhere in the repo. */
export const moneyFiles = ['money', 'ledger', 'pricing'].map((d) => `**/${d}/**/*.${CODE_EXT}`);
/** Server source files subject to the clock rule. */
export const serverFiles = [`apps/server/src/**/*.${CODE_EXT}`];
/** The single place allowed to read the wall clock. */
export const clockFile = 'apps/server/src/lib/clock.ts';
/** Server money paths: both restriction sets must apply (flat config replaces, not merges, rule options). */
export const serverMoneyFiles = ['money', 'ledger', 'pricing'].map(
  (d) => `apps/server/src/**/${d}/**/*.${CODE_EXT}`,
);

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

  // Restrictions must not be switched off with comments: no disabling no-restricted-syntax, no blanket
  // disables, no inline rule configuration (/* eslint rule: off */).
  {
    files: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
    plugins: { '@eslint-community/eslint-comments': eslintComments },
    rules: {
      '@eslint-community/eslint-comments/no-restricted-disable': ['error', 'no-restricted-syntax'],
      '@eslint-community/eslint-comments/no-unlimited-disable': 'error',
      '@eslint-community/eslint-comments/no-use': [
        'error',
        {
          allow: [
            'eslint-disable-next-line',
            'eslint-disable-line',
            'eslint-disable',
            'eslint-enable',
          ],
        },
      ],
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

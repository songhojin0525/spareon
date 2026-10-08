import { fileURLToPath } from 'node:url';

import { ESLint, type Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

// Proves that the real root eslint.config.mjs rejects forbidden code. Sample files are virtual
// (lintText + filePath) so the repository itself stays clean.
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

// Virtual files are not part of any tsconfig, so type-aware parsing is disabled for them.
// The custom restrictions are syntax-only, so this does not weaken what is being proven.
const syntaxOnly = new ESLint({
  cwd: repoRoot,
  overrideConfig: [{ files: ['**/*.{ts,mts,cts}'], ...tseslint.configs.disableTypeChecked }],
});
const typed = new ESLint({ cwd: repoRoot });

async function restricted(filePath: string, code: string): Promise<Linter.LintMessage[]> {
  expect(await syntaxOnly.isPathIgnored(filePath)).toBe(false);
  const [result] = await syntaxOnly.lintText(code, { filePath });
  if (result === undefined) throw new Error('no lint result');
  const fatal = result.messages.filter((m) => m.fatal === true);
  expect(fatal).toEqual([]);
  return result.messages.filter((m) => m.ruleId === 'no-restricted-syntax');
}

const SERVER_FILE = 'apps/server/src/jobs/sample.ts';
const MONEY_FILES = [
  'packages/shared/src/money/sample.ts',
  'apps/server/src/ledger/sample.ts',
  'apps/server/src/billing/pricing/sample.ts',
  'tools/econ-sim/src/money/sample.mjs',
];

describe('server clock restriction', () => {
  it.each([
    ['Date.now()', 'export const t = Date.now();'],
    ['new Date()', 'export const d = new Date();'],
    ['Date()', 'export const s = Date();'],
    ['Date.now as a reference', 'export const clock = { now: Date.now };'],
    ['computed Date["now"]', "export const t = Date['now']();"],
    ['new Date(...[])', 'export const d = new Date(...[]);'],
    ['globalThis.Date', 'export const d = new globalThis.Date(0);'],
    ['Temporal.Now', 'export const t = Temporal.Now;'],
  ])('rejects %s in server code', async (_label, code) => {
    const msgs = await restricted(SERVER_FILE, code);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.severity).toBe(2);
    expect(msgs[0]?.message).toMatch(/Clock/);
  });

  it('allows constructing explicit dates', async () => {
    const code =
      "export const a = new Date(0);\nexport const b = new Date('2026-01-01T00:00:00Z');\n";
    expect(await restricted(SERVER_FILE, code)).toEqual([]);
  });

  it('exempts apps/server/src/lib/clock.ts only', async () => {
    expect(
      await restricted('apps/server/src/lib/clock.ts', 'export const n = new Date();'),
    ).toEqual([]);
    expect(
      await restricted('apps/server/src/lib/other.ts', 'export const n = new Date();'),
    ).toHaveLength(1);
  });

  it('does not apply outside the server', async () => {
    expect(
      await restricted('packages/testkit/src/sample.ts', 'export const t = Date.now();'),
    ).toEqual([]);
  });
});

describe('money restriction', () => {
  const violations: [string, string][] = [
    ['parseFloat', "export const a = parseFloat('1.5');"],
    ['Number()', "export const a = Number('15');"],
    ['Number.parseFloat', "export const a = Number.parseFloat('1.5');"],
    ['Number.parseInt', "export const a = Number.parseInt('15', 10);"],
    ['Math.round', 'export const a = Math.round(15);'],
    ['Math.floor', 'export const a = Math.floor(15);'],
    ['toFixed', 'export const a = (15).toFixed(2);'],
    ['float literal arithmetic', 'export const fee = (x) => x * 0.05;'],
    ['decimal literal', 'export const rate = 1.5;'],
    ['leading-dot literal', 'export const rate = .5;'],
    ['exponent literal', 'export const big = 1e6;'],
    ['parseInt', "export const a = parseInt('15', 10);"],
    ['map(Number)', "export const a = ['1'].map(Number);"],
    ['unary plus', "export const a = +'1.5';"],
    ['globalThis.parseFloat', "export const a = globalThis.parseFloat('1.5');"],
    ['toPrecision', 'export const a = (15).toPrecision(2);'],
    ['destructured Math', 'const { round } = Math;\nexport const a = round;'],
    ['Infinity', 'export const a = Infinity;'],
  ];

  for (const file of MONEY_FILES) {
    it.each(violations)(`rejects %s in ${file}`, async (_label, code) => {
      const msgs = await restricted(file, code);
      expect(msgs.length).toBeGreaterThanOrEqual(1);
      expect(msgs.every((m) => m.severity === 2)).toBe(true);
    });
  }

  it('allows bigint, integer, hex and string code', async () => {
    const code = [
      'export const MICRO = 1_000_000n;',
      'export const n = 10;',
      'export const hex = 0x1e;',
      "export const s = '1.5';",
      "export const b = BigInt('5') * 2n;",
    ].join('\n');
    for (const file of MONEY_FILES) {
      expect(await restricted(file, code)).toEqual([]);
    }
  });

  it('does not apply to non-money paths', async () => {
    expect(
      await restricted('packages/shared/src/time/sample.ts', 'export const a = Math.round(1.5);'),
    ).toEqual([]);
  });

  it('server money paths keep BOTH the clock and the money restriction', async () => {
    const msgs = await restricted(
      'apps/server/src/ledger/sample.ts',
      "export const t = Date.now();\nexport const a = parseFloat('1');\n",
    );
    expect(msgs).toHaveLength(2);
    expect(msgs.map((m) => m.line).sort()).toEqual([1, 2]);
  });
});

describe('restrictions cannot be switched off with comments', () => {
  it.each([
    [
      'disable-next-line',
      '// eslint-disable-next-line no-restricted-syntax\nexport const t = Date.now();',
    ],
    ['blanket disable', '/* eslint-disable */\nexport const t = Date.now();'],
    ['inline rule config', '/* eslint no-restricted-syntax: off */\nexport const t = Date.now();'],
  ])('%s is reported', async (_label, code) => {
    const [result] = await syntaxOnly.lintText(code, { filePath: SERVER_FILE });
    const errors = result?.messages.filter((m) => m.severity === 2) ?? [];
    expect(
      errors.some((m) => (m.ruleId ?? '').startsWith('@eslint-community/eslint-comments/')),
    ).toBe(true);
  });
});

describe('type-aware rules are active on real project files', () => {
  it('reports floating promises in apps/server', async () => {
    const code = [
      'async function work(): Promise<void> {}',
      'export function run(): void {',
      '  work();',
      '}',
      '',
    ].join('\n');
    const [result] = await typed.lintText(code, { filePath: 'apps/server/src/app.ts' });
    const ids = result?.messages.map((m) => m.ruleId) ?? [];
    expect(result?.messages.filter((m) => m.fatal === true)).toEqual([]);
    expect(ids).toContain('@typescript-eslint/no-floating-promises');
  });

  it('enforces type-only imports and import order', async () => {
    const code = [
      "import { z } from 'zod';",
      "import { FastifyInstance } from 'fastify';",
      'export type A = FastifyInstance;',
      'export const s = z.string();',
      '',
    ].join('\n');
    const [result] = await typed.lintText(code, { filePath: 'apps/server/src/app.ts' });
    const ids = result?.messages.map((m) => m.ruleId) ?? [];
    expect(ids).toContain('simple-import-sort/imports');
    expect(ids).toContain('@typescript-eslint/consistent-type-imports');
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  compareWithTable,
  formatMarkers,
  parseMarkers,
  readReplacementTable,
  scanSkeletons,
} from '../../../scripts/check-skeleton.mjs';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const STAGES = new Set(['S05', 'S06', 'S08', 'S12']);

let root: string;
const write = (rel: string, text: string): void => {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'check-skeleton-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('parseMarkers', () => {
  it('reads single and multi-stage markers with their description', () => {
    const r = parseMarkers(
      'a.ts',
      '// SKELETON(S05): dev key\nconst x = 1;\n// SKELETON(S06, S08): fixed price\n',
      STAGES,
    );
    expect(r.problems).toEqual([]);
    expect(r.markers).toEqual([
      { file: 'a.ts', line: 1, stages: ['S05'], text: 'dev key' },
      { file: 'a.ts', line: 3, stages: ['S06', 'S08'], text: 'fixed price' },
    ]);
  });

  it('flags malformed markers, missing descriptions and unknown stages', () => {
    const r = parseMarkers(
      'b.go',
      [
        '// SKELETON(S5): x',
        '// SKELETON(SNN): x',
        '// SKELETON(S05)',
        '// SKELETON(S05):   ',
        '// SKELETON(S99): x',
        '// see (SKELETON(S12)) above',
      ].join('\n'),
      STAGES,
    );
    expect(r.problems).toEqual([
      'b.go:1: malformed marker (expected "SKELETON(SNN): <what replaces it>")',
      'b.go:2: malformed marker (expected "SKELETON(SNN): <what replaces it>")',
      'b.go:3: marker needs ": <what replaces it>"',
      'b.go:4: marker needs ": <what replaces it>"',
      'b.go:5: unknown stage S99',
      'b.go:6: marker needs ": <what replaces it>"',
    ]);
  });
});

describe('scanSkeletons', () => {
  it('scans code files only and skips node_modules', () => {
    write('prompts/STAGES.md', '| S05 | x |\n| S12 | y |\n');
    write('apps/a/src/x.ts', '// SKELETON(S05): one key\n');
    write('apps/a/src/y.go', '// SKELETON(S12): first node\n');
    write('docs/notes.md', 'SKELETON(S05): talked about in docs\n');
    write('node_modules/p/index.js', '// SKELETON(S05): vendored\n');
    const { markers, problems } = scanSkeletons(root);
    expect(problems).toEqual([]);
    expect(markers.map((m) => `${m.file}:${String(m.line)}`)).toEqual([
      'apps/a/src/x.ts:1',
      'apps/a/src/y.go:1',
    ]);
    expect(formatMarkers(markers)).toBe(
      'S05 (1)\n  apps/a/src/x.ts:1  one key\nS12 (1)\n  apps/a/src/y.go:1  first node',
    );
  });

  it('finds no malformed markers in this repository', () => {
    expect(scanSkeletons(repoRoot).problems).toEqual([]);
  });
});

describe('replacement table (REPORT 교체 목록)', () => {
  const report = [
    '# S04 보고서',
    '## 교체 목록',
    '| 파일 | 대체 차수 | 단순화한 것 |',
    '|---|---|---|',
    '| `apps/a/src/x.ts` | S05 | one key |',
    '| `apps/a/src/y.go:1` | S06, S08 | price |',
    '',
    '## 다음',
    '| 파일 | 대체 차수 |',
    '| ignored.ts | S12 |',
  ].join('\n');

  it('reads (file, stage) pairs from the first table after the heading', () => {
    expect([...(readReplacementTable(report) ?? [])].sort()).toEqual([
      'apps/a/src/x.ts S05',
      'apps/a/src/y.go S06',
      'apps/a/src/y.go S08',
    ]);
    expect(readReplacementTable('# no table here')).toBeNull();
  });

  it('reports pairs missing on either side', () => {
    const table = readReplacementTable(report) ?? new Set<string>();
    const markers = [
      { file: 'apps/a/src/x.ts', line: 1, stages: ['S05'], text: 'one key' },
      { file: 'apps/a/src/y.go', line: 1, stages: ['S06'], text: 'price' },
      { file: 'apps/a/src/z.ts', line: 9, stages: ['S12'], text: 'new' },
    ];
    expect(compareWithTable(markers, table)).toEqual([
      'in code but not in the report table: apps/a/src/z.ts S12',
      'in the report table but not in code: apps/a/src/y.go S08',
    ]);
  });
});

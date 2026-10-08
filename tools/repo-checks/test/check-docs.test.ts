import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkDocs, stripCode } from '../../../scripts/check-docs.mjs';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

let root: string;
const write = (rel: string, text: string): void => {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

const GOOD_ADR = [
  '# 0001. Something',
  '## 맥락',
  'x',
  '## 결정',
  'x',
  '## 검토한 대안',
  'x',
  '## 결과와 트레이드오프',
  'x',
  '## 재검토 조건',
  'x',
  '',
].join('\n');

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'binjari-docs-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('check-docs', () => {
  it('passes a clean tree', () => {
    write('README.md', '[start](START_HERE.md) [web](https://example.com) [here](#top)\n');
    write('START_HERE.md', '# hi\n');
    write('docs/adr/0001-something.md', GOOD_ADR);
    expect(checkDocs(root)).toEqual([]);
  });

  it('reports broken relative links with file and line', () => {
    write('docs/a.md', 'line1\nsee [b](../missing.md#part)\n');
    expect(checkDocs(root)).toEqual(['docs/a.md:2: broken link -> ../missing.md#part']);
  });

  it('requires the exact letter case of link targets (Linux CI is case-sensitive)', () => {
    write('START_HERE.md', '# hi\n');
    write('README.md', '[a](START_HERE.md)\n[b](start_here.md)\n');
    expect(checkDocs(root)).toEqual(['README.md:2: broken link -> start_here.md']);
  });

  it('ignores links inside code fences and inline code', () => {
    write('a.md', '```\n[x](nope.md)\n```\n`[y](nope.md)`\n');
    expect(checkDocs(root)).toEqual([]);
    expect(stripCode('a\n```\nb\n```\nc').split('\n')).toHaveLength(5);
  });

  it('requires ADR sections, title and unique numbers', () => {
    write('docs/adr/0001-a.md', GOOD_ADR);
    write('docs/adr/0001-b.md', GOOD_ADR);
    write('docs/adr/0002-c.md', '# c\n## 맥락\n## 결정\n');
    write('docs/adr/3-bad-name.md', GOOD_ADR);
    const problems = checkDocs(root);
    expect(problems).toContain(
      'docs/adr/0001-b.md: duplicate ADR number 0001 (also docs/adr/0001-a.md)',
    );
    expect(problems).toContain("docs/adr/0002-c.md: missing section '## 검토한 대안'");
    expect(problems).toContain("docs/adr/0002-c.md: missing section '## 재검토 조건'");
    expect(problems).toContain('docs/adr/3-bad-name.md: ADR file name must be NNNN-kebab-title.md');
  });

  it('rejects unknown stage statuses in PROGRESS.md and REPORT.md', () => {
    write(
      'PROGRESS.md',
      '| 차수 | 상태 |\n|---|---|\n| S00 | DONE | x |\n| S01 | FINISHED | x |\n',
    );
    write('docs/stages/S00/REPORT.md', '# r\n\n- 상태: MOSTLY_DONE\n');
    write('docs/stages/S01/REPORT.md', '# r\n');
    const problems = checkDocs(root);
    expect(problems).toContain("PROGRESS.md:4: S01 has unknown status 'FINISHED'");
    expect(problems).toContain("docs/stages/S00/REPORT.md: unknown status 'MOSTLY_DONE'");
    expect(problems).toContain("docs/stages/S01/REPORT.md: missing '- 상태: <STATUS>' line");
  });

  it('accepts BLOCKED with a dependency note in PROGRESS.md', () => {
    write('PROGRESS.md', '| S05 | BLOCKED(의존: S04) | x |\n');
    expect(checkDocs(root)).toEqual([]);
  });

  it('checks only the status table, not later tables keyed by stage ID', () => {
    write(
      'PROGRESS.md',
      '| 차수 | 상태 |\n|---|---|\n| S00 | DONE | x |\n| S01 | WAT | x |\n\n## 가정 기록\n| 차수 | 가정 | 근거 |\n|---|---|---|\n| S00 | pnpm 11 고정 | 이유 |\n',
    );
    expect(checkDocs(root)).toEqual(["PROGRESS.md:4: S01 has unknown status 'WAT'"]);
  });

  it('the repository itself passes', () => {
    expect(checkDocs(repoRoot)).toEqual([]);
  });
});

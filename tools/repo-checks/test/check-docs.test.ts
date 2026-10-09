import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkDocs,
  extractMermaidBlocks,
  REQUIRED_FILES,
  splitRow,
  STATE_ACTORS,
  stripCode,
} from '../../../scripts/check-docs.mjs';

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

  it('the repository itself passes, including the required design documents', () => {
    expect(checkDocs(repoRoot, { requiredFiles: REQUIRED_FILES })).toEqual([]);
  });

  it('ARCHITECTURE.md keeps at least 10 sequence diagrams and 6 state machines (S01 criterion 2)', () => {
    const text = readFileSync(path.join(repoRoot, 'docs', 'ARCHITECTURE.md'), 'utf8');
    const kinds = extractMermaidBlocks(text).map(
      (b) => b.body.find((l) => l.trim() !== '' && !l.trim().startsWith('%%'))?.trim() ?? '',
    );
    expect(kinds.filter((k) => k.startsWith('sequenceDiagram')).length).toBeGreaterThanOrEqual(10);
    expect(kinds.filter((k) => k.startsWith('stateDiagram')).length).toBeGreaterThanOrEqual(6);
  });
});

const STAGES = '| ID | 파일 |\n|---|---|\n| S00 | a |\n| S01 | b |\n| S12 | c |\n';

describe('check-docs: stage and ADR references', () => {
  it('flags stage IDs that are not in prompts/STAGES.md', () => {
    write('prompts/STAGES.md', STAGES);
    write(
      'docs/a.md',
      'S00 and S12 exist.\nS13 does not, nor `SKELETON(S40)`.\nS1 and SNN are not IDs.\n',
    );
    expect(checkDocs(root)).toEqual([
      'docs/a.md:2: unknown stage S13 (not in prompts/STAGES.md)',
      'docs/a.md:2: unknown stage S40 (not in prompts/STAGES.md)',
    ]);
  });

  it('does not treat longer tokens as stage IDs', () => {
    write('prompts/STAGES.md', STAGES);
    write('docs/a.md', 'S300 매장, AS01, S12a, xS99 are not stage references.\n');
    expect(checkDocs(root)).toEqual([]);
  });

  it('skips the stage check when there is no STAGES.md', () => {
    write('docs/a.md', 'S99\n');
    expect(checkDocs(root)).toEqual([]);
  });

  it('requires an ADR file for every "ADR NNNN" text reference', () => {
    write('docs/adr/0001-something.md', GOOD_ADR);
    write('docs/a.md', 'ADR 0001 ok, ADR-0001 ok\nADR 0007 missing\n');
    expect(checkDocs(root)).toEqual(['docs/a.md:2: ADR 0007 has no file in docs/adr/']);
  });
});

describe('check-docs: mermaid structure and state machine actors', () => {
  it('rejects empty and unclosed mermaid blocks', () => {
    write('docs/a.md', '# a\n```mermaid\n\n%% only a comment\n```\n');
    write('docs/b.md', '# b\n```mermaid\nflowchart LR\n  a --> b\n');
    expect(checkDocs(root)).toEqual([
      'docs/a.md:2: mermaid block is empty',
      'docs/b.md:2: mermaid block is not closed',
    ]);
  });

  it('extracts mermaid blocks but not other fences', () => {
    const blocks = extractMermaidBlocks('```js\nx\n```\n```mermaid\nflowchart LR\n  a-->b\n```\n');
    expect(blocks).toEqual([{ line: 4, body: ['flowchart LR', '  a-->b'], closed: true }]);
  });

  it('requires a known trigger actor on every state transition under docs/', () => {
    write(
      'docs/a.md',
      [
        '```mermaid',
        'stateDiagram-v2',
        '  [*] --> idle : [에이전트] 인증 성공',
        '  idle --> running : [스케줄러/에이전트] 수락',
        '  running --> idle',
        '  idle --> gone : 이유만 있음',
        '  idle --> x : [고양이] 모름',
        '```',
        '',
      ].join('\n'),
    );
    expect(checkDocs(root)).toEqual([
      "docs/a.md:5: state transition without a trigger actor (': [actor] event')",
      "docs/a.md:6: state transition without a trigger actor (': [actor] event')",
      "docs/a.md:7: unknown trigger actor '고양이' (see STATE_ACTORS)",
    ]);
    expect(STATE_ACTORS).toContain('손님');
  });

  it('requires an event after the actor and ignores actors hidden in %% comments', () => {
    write(
      'docs/a.md',
      [
        '```mermaid',
        'stateDiagram-v2',
        '  a --> b : [에이전트]',
        '  b --> c : 사건 %%: [운영자]',
        '  c --> d : [운영자] 해제 %% 주석은 괜찮다',
        '```',
        '',
      ].join('\n'),
    );
    expect(checkDocs(root)).toEqual([
      "docs/a.md:3: state transition without an event after the actor (': [actor] event')",
      "docs/a.md:4: state transition without a trigger actor (': [actor] event')",
    ]);
  });

  it('finds the diagram type after mermaid front matter', () => {
    write('docs/a.md', '```mermaid\n---\ntitle: 노드\n---\nstateDiagram-v2\n  a --> b\n```\n');
    expect(checkDocs(root)).toEqual([
      "docs/a.md:6: state transition without a trigger actor (': [actor] event')",
    ]);
  });

  it('does not apply the actor rule outside docs/ or to non-state diagrams', () => {
    write('prompts/x.md', '```mermaid\nstateDiagram-v2\n  a --> b\n```\n');
    write('docs/f.md', '```mermaid\nflowchart LR\n  a --> b\n```\n');
    expect(checkDocs(root)).toEqual([]);
  });
});

describe('check-docs: threat model tables', () => {
  const header = '| ID | 위협 | 완화 | 담당 차수 |\n|---|---|---|---|\n';

  it('accepts stage IDs and explicit acceptance reasons', () => {
    write(
      'docs/THREAT_MODEL.md',
      `# t\n${header}| T-1 | a | b | S06, S12 |\n| T-2 | a | 없음 | 수용: 1인 운영 비용이 이득보다 크다 |\n\n| 다른 표 | x |\n|---|---|\n| y | z |\n`,
    );
    expect(checkDocs(root)).toEqual([]);
  });

  it('rejects rows without a stage or a reason, free text, and duplicate IDs', () => {
    write(
      'docs/THREAT_MODEL.md',
      [
        '# t',
        header.trimEnd(),
        '| T-1 | a | b | 나중에 |',
        '| T-2 | a | b | 수용: |',
        '| T-1 | a | b | S06 |',
        '| | a | b | S06 |',
        '| T-3 | a | b | 나중에 S01에서 검토 안 함 |',
        '| T-4 | a | b | 수용: - |',
        '| T-5 | a | b | S06 아마도 |',
        '',
      ].join('\n'),
    );
    const msg = "'담당 차수' must be stage IDs only (SNN, SNN) or '수용: <reason>'";
    expect(checkDocs(root)).toEqual([
      `docs/THREAT_MODEL.md:4: ${msg}`,
      `docs/THREAT_MODEL.md:5: ${msg}`,
      'docs/THREAT_MODEL.md:6: duplicate threat ID T-1 (also line 4)',
      'docs/THREAT_MODEL.md:7: threat row without ID',
      `docs/THREAT_MODEL.md:8: ${msg}`,
      `docs/THREAT_MODEL.md:9: ${msg}`,
      `docs/THREAT_MODEL.md:10: ${msg}`,
    ]);
  });

  it('requires at least one threat table', () => {
    write('docs/THREAT_MODEL.md', '# t\n| a | b |\n|---|---|\n| 1 | 2 |\n');
    expect(checkDocs(root)).toEqual([
      "docs/THREAT_MODEL.md: no threat table with a '담당 차수' column",
    ]);
  });

  it('keeps escaped pipes inside a cell', () => {
    expect(splitRow('| a \\| b | c |')).toEqual(['a \\| b', 'c']);
  });
});

describe('check-docs: required files', () => {
  it('reports missing required files and supports * in the file name', () => {
    write('docs/adr/0002-postgres-queue.md', GOOD_ADR.replace('0001', '0002'));
    write('docs/MVP.md', '# mvp\n');
    expect(
      checkDocs(root, {
        requiredFiles: ['docs/MVP.md', 'docs/adr/0002-*.md', 'docs/adr/0003-*.md', 'docs/X.md'],
      }),
    ).toEqual([
      'docs/adr/0003-*.md: required file is missing',
      'docs/X.md: required file is missing',
    ]);
  });

  it('lists every S01 design document', () => {
    expect(REQUIRED_FILES).toContain('docs/THREAT_MODEL.md');
    expect(REQUIRED_FILES.filter((f) => f.startsWith('docs/adr/'))).toHaveLength(15);
  });
});

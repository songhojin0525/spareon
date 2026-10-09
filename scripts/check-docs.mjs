#!/usr/bin/env node
// @ts-check
// Documentation checks. Exit code 1 on any problem.
//   1. Relative Markdown links point to files that exist.
//   2. ADRs (docs/adr/NNNN-*.md) have unique 4-digit numbers, a title and the required sections.
//   3. PROGRESS.md stage rows and stage REPORT.md files use only the allowed status values.
//   4. Every stage reference (S00..) exists in prompts/STAGES.md; every "ADR NNNN" text reference has a file.
//   5. Mermaid blocks are closed and not empty; stateDiagram transitions under docs/ name a trigger actor
//      and an event (": [actor] event", actor from STATE_ACTORS; front matter and %% comments handled).
//   6. docs/THREAT_MODEL.md: every row of a table with a '담당 차수' column holds only stage IDs or
//      '수용: <reason>' (reason of 4+ letters), and threat IDs are unique.
//   7. (CLI only) the design documents every later stage relies on exist (REQUIRED_FILES).
// Mermaid *syntax* is checked by tools/repo-checks/test/mermaid-syntax.test.ts with the real parser,
// because that needs dependencies and this script must run before `pnpm install`.
// Dependency-free on purpose (Node built-ins only) so it runs before `pnpm install` too.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.runner',
  'dist',
  'coverage',
  '.next',
  '.turbo',
]);

export const ADR_SECTIONS = ['맥락', '결정', '검토한 대안', '결과와 트레이드오프', '재검토 조건'];
export const STAGE_STATUSES = ['TODO', 'IN_PROGRESS', 'DONE', 'DONE_NEEDS_HUMAN', 'BLOCKED'];
const REPORT_STATUSES = ['DONE', 'DONE_NEEDS_HUMAN', 'BLOCKED', 'IN_PROGRESS'];

/** Design documents later stages rely on (S01). Checked by the CLI run, not by checkDocs() defaults. */
export const REQUIRED_FILES = [
  'docs/ARCHITECTURE.md',
  'docs/THREAT_MODEL.md',
  'docs/MVP.md',
  'docs/GLOSSARY.md',
  'docs/KNOWN_UNKNOWNS.md',
  ...Array.from({ length: 15 }, (_, i) => `docs/adr/${String(i + 2).padStart(4, '0')}-*.md`),
];

/** Who may trigger a state transition (ARCHITECTURE.md state machines). */
export const STATE_ACTORS = [
  '에이전트',
  '헬퍼',
  '업데이터',
  '손님',
  '사장님',
  '운영자',
  '구매자',
  '서버',
  '게이트웨이',
  '스케줄러',
  '플릿',
  '원장',
  '계량',
  '검증',
  '배치',
  '외부제공사',
  '릴리스',
  '시계',
  'CI',
];

const THREAT_FILE = 'docs/THREAT_MODEL.md';
const THREAT_STAGE_COLUMN = '담당 차수';

/**
 * @param {string} root
 * @returns {string[]} repo-relative paths with forward slashes
 */
export function listMarkdown(root) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        out.push(path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/'));
      }
    }
  };
  walk(root);
  return out.sort();
}

/**
 * Remove fenced code blocks and inline code so example links inside them are not checked.
 * Line count is preserved so reported line numbers stay correct.
 * @param {string} text
 */
export function stripCode(text) {
  const lines = text.split(/\r?\n/);
  let fence = '';
  return lines
    .map((line) => {
      const m = /^\s*(```+|~~~+)/.exec(line);
      if (m?.[1] !== undefined) {
        const marker = m[1];
        if (fence === '') fence = marker[0] ?? '';
        else if (marker.startsWith(fence)) fence = '';
        return '';
      }
      return fence === '' ? line.replace(/`[^`]*`/g, '') : '';
    })
    .join('\n');
}

/**
 * @param {string} root
 * @param {string} file repo-relative path
 * @param {string} text
 * @returns {string[]} problems
 */
export function checkLinks(root, file, text) {
  /** @type {string[]} */
  const problems = [];
  const lines = stripCode(text).split('\n');
  const linkRe = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
  lines.forEach((line, i) => {
    for (const m of line.matchAll(linkRe)) {
      const target = m[1] ?? '';
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue; // external or same-page anchor
      const clean = decodeURIComponent(target.split('#')[0]?.split('?')[0] ?? '');
      if (clean === '') continue;
      const resolved = clean.startsWith('/')
        ? path.join(root, clean)
        : path.join(root, path.dirname(file), clean);
      if (!existsExactCase(root, resolved)) {
        problems.push(`${file}:${i + 1}: broken link -> ${target}`);
      }
    }
  });
  return problems;
}

/**
 * Like existsSync, but also requires the exact letter case of every path segment under root.
 * Windows and macOS file systems ignore case; Linux (CI) does not, so a link must match exactly.
 * @param {string} root
 * @param {string} target absolute path
 */
export function existsExactCase(root, target) {
  if (!existsSync(target)) return false;
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return true; // outside the repo: best effort
  let dir = root;
  for (const segment of rel.split(path.sep).filter((x) => x !== '' && x !== '.')) {
    if (!readdirSync(dir).includes(segment)) return false;
    dir = path.join(dir, segment);
  }
  return true;
}

/**
 * @param {string} root
 * @returns {string[]} problems
 */
export function checkAdrs(root) {
  const dir = path.join(root, 'docs', 'adr');
  if (!existsSync(dir)) return [];
  /** @type {string[]} */
  const problems = [];
  /** @type {Map<string, string>} */
  const seen = new Map();
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.md')) continue;
    const rel = `docs/adr/${name}`;
    const m = /^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.exec(name);
    if (m?.[1] === undefined) {
      if (name.toLowerCase() !== 'readme.md')
        problems.push(`${rel}: ADR file name must be NNNN-kebab-title.md`);
      continue;
    }
    const num = m[1];
    const prev = seen.get(num);
    if (prev !== undefined) problems.push(`${rel}: duplicate ADR number ${num} (also ${prev})`);
    seen.set(num, rel);
    const text = readFileSync(path.join(dir, name), 'utf8');
    if (!/^# .+/m.test(text)) problems.push(`${rel}: missing '# ' title`);
    const headings = new Set(
      [...text.matchAll(/^##\s+(.+?)\s*$/gm)].map((h) => (h[1] ?? '').trim()),
    );
    for (const section of ADR_SECTIONS) {
      if (!headings.has(section)) problems.push(`${rel}: missing section '## ${section}'`);
    }
  }
  return problems;
}

/**
 * @param {string} root
 * @returns {string[]} problems
 */
export function checkStatuses(root) {
  /** @type {string[]} */
  const problems = [];
  const progress = path.join(root, 'PROGRESS.md');
  if (existsSync(progress)) {
    // Only the first table is the status table; later tables (assumptions, run log) also start rows with stage IDs.
    let tableIndex = -1;
    let inTable = false;
    readFileSync(progress, 'utf8')
      .split(/\r?\n/)
      .forEach((line, i) => {
        const isRow = line.trim().startsWith('|');
        if (isRow && !inTable) tableIndex += 1;
        inTable = isRow;
        if (tableIndex !== 0) return;
        const m = /^\|\s*(S\d{2})\s*\|\s*([^|]*?)\s*\|/.exec(line);
        if (m === null) return;
        const status = (m[2] ?? '').replace(/\(.*\)$/, '').trim();
        if (!STAGE_STATUSES.includes(status)) {
          problems.push(`PROGRESS.md:${i + 1}: ${m[1] ?? ''} has unknown status '${m[2] ?? ''}'`);
        }
      });
  }
  const stagesDir = path.join(root, 'docs', 'stages');
  if (existsSync(stagesDir)) {
    for (const stage of readdirSync(stagesDir).sort()) {
      const report = path.join(stagesDir, stage, 'REPORT.md');
      if (!statSync(path.join(stagesDir, stage)).isDirectory() || !existsSync(report)) continue;
      const m = /^- 상태:\s*(\S+)/m.exec(readFileSync(report, 'utf8'));
      const rel = `docs/stages/${stage}/REPORT.md`;
      if (m?.[1] === undefined) problems.push(`${rel}: missing '- 상태: <STATUS>' line`);
      else if (!REPORT_STATUSES.includes(m[1])) problems.push(`${rel}: unknown status '${m[1]}'`);
    }
  }
  return problems;
}

/**
 * Stage IDs declared in the prompts/STAGES.md table, or null when the file does not exist.
 * @param {string} root
 * @returns {Set<string> | null}
 */
export function readStageIds(root) {
  const file = path.join(root, 'prompts', 'STAGES.md');
  if (!existsSync(file)) return null;
  /** @type {Set<string>} */
  const ids = new Set();
  for (const m of readFileSync(file, 'utf8').matchAll(/^\|\s*(S\d{2})\s*\|/gm)) {
    if (m[1] !== undefined) ids.add(m[1]);
  }
  return ids;
}

/**
 * @param {string} file repo-relative path
 * @param {string} text
 * @param {Set<string>} stageIds
 * @returns {string[]} problems
 */
export function checkStageRefs(file, text, stageIds) {
  /** @type {string[]} */
  const problems = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const m of line.matchAll(/(?<![A-Za-z0-9_])S(\d{2})(?![0-9])/g)) {
      const id = `S${m[1] ?? ''}`;
      if (!stageIds.has(id))
        problems.push(`${file}:${i + 1}: unknown stage ${id} (not in prompts/STAGES.md)`);
    }
  });
  return problems;
}

/**
 * @param {string} root
 * @returns {Set<string>} 4-digit ADR numbers that have a file
 */
export function listAdrNumbers(root) {
  const dir = path.join(root, 'docs', 'adr');
  /** @type {Set<string>} */
  const out = new Set();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const num = /^(\d{4})-.+\.md$/.exec(name)?.[1];
    if (num !== undefined) out.add(num);
  }
  return out;
}

/**
 * Text references such as "ADR 0008" or "ADR-0011" must point to an existing ADR file.
 * @param {string} file
 * @param {string} text
 * @param {Set<string>} adrNumbers
 * @returns {string[]} problems
 */
export function checkAdrRefs(file, text, adrNumbers) {
  /** @type {string[]} */
  const problems = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const m of line.matchAll(/\bADR[\s-]?(\d{4})\b/g)) {
      if (!adrNumbers.has(m[1] ?? ''))
        problems.push(`${file}:${i + 1}: ADR ${m[1] ?? ''} has no file in docs/adr/`);
    }
  });
  return problems;
}

/**
 * @typedef {{ line: number, body: string[], closed: boolean }} MermaidBlock
 * line = 1-based line number of the opening fence
 */

/**
 * @param {string} text
 * @returns {MermaidBlock[]}
 */
export function extractMermaidBlocks(text) {
  /** @type {MermaidBlock[]} */
  const blocks = [];
  /** @type {MermaidBlock | null} */
  let current = null;
  let fence = '';
  text.split(/\r?\n/).forEach((line, i) => {
    const m = /^\s*(```+|~~~+)\s*([A-Za-z0-9_-]*)/.exec(line);
    if (fence === '') {
      if (m?.[1] === undefined) return;
      fence = m[1];
      if ((m[2] ?? '').toLowerCase() === 'mermaid') {
        current = { line: i + 1, body: [], closed: false };
        blocks.push(current);
      }
      return;
    }
    if (m?.[1] !== undefined && m[1].startsWith(fence) && (m[2] ?? '') === '') {
      fence = '';
      if (current !== null) current.closed = true;
      current = null;
      return;
    }
    if (current !== null) current.body.push(line);
  });
  return blocks;
}

/**
 * The diagram keyword of a mermaid block (first content line after an optional `---` front matter).
 * @param {string[]} content non-empty, non-comment lines of the block
 */
export function diagramKind(content) {
  let k = 0;
  if (content[0]?.trim() === '---') {
    const close = content.findIndex((l, i) => i > 0 && l.trim() === '---');
    k = close < 0 ? content.length : close + 1;
  }
  return content[k]?.trim() ?? '';
}

/**
 * @param {string} file
 * @param {string} text
 * @returns {string[]} problems
 */
export function checkMermaid(file, text) {
  /** @type {string[]} */
  const problems = [];
  const underDocs = file.startsWith('docs/');
  for (const block of extractMermaidBlocks(text)) {
    if (!block.closed) problems.push(`${file}:${block.line}: mermaid block is not closed`);
    const content = block.body.filter((l) => l.trim() !== '' && !l.trim().startsWith('%%'));
    if (content.length === 0) {
      problems.push(`${file}:${block.line}: mermaid block is empty`);
      continue;
    }
    if (!underDocs || !/^stateDiagram/.test(diagramKind(content))) continue;
    block.body.forEach((raw, j) => {
      // Text after %% is a mermaid comment: an actor written there does not count.
      const line = raw.replace(/%%.*$/, '').trim();
      if (!line.includes('-->')) return;
      const where = `${file}:${block.line + j + 1}`;
      const label = /:\s*\[([^\]]+)\]\s*(\S?)/.exec(line);
      if (label?.[1] === undefined) {
        problems.push(`${where}: state transition without a trigger actor (': [actor] event')`);
        return;
      }
      if (label[2] === '') {
        problems.push(
          `${where}: state transition without an event after the actor (': [actor] event')`,
        );
      }
      for (const actor of label[1].split(/[/·,]/).map((a) => a.trim())) {
        if (!STATE_ACTORS.includes(actor))
          problems.push(`${where}: unknown trigger actor '${actor}' (see STATE_ACTORS)`);
      }
    });
  }
  return problems;
}

/**
 * Split a Markdown table row into trimmed cells (an escaped \| stays inside its cell).
 * @param {string} line
 */
export function splitRow(line) {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return body.split(/(?<!\\)\|/).map((c) => c.trim());
}

/**
 * A '담당 차수' cell is either a plain list of stage IDs ("S05, S12") or an explicit acceptance
 * ("수용: <reason>") whose reason has at least 4 letters or digits, so "나중에 S01" or "수용: -" fail.
 * @param {string} value
 */
export function isStageCell(value) {
  if (/^S\d{2}(?:\s*,\s*S\d{2})*$/.test(value)) return true;
  const reason = /^수용\s*[:：]\s*(.*)$/.exec(value)?.[1] ?? '';
  return reason.replace(/[^\p{L}\p{N}]/gu, '').length >= 4;
}

/**
 * @param {string} root
 * @returns {string[]} problems
 */
export function checkThreatModel(root) {
  const full = path.join(root, ...THREAT_FILE.split('/'));
  if (!existsSync(full)) return [];
  /** @type {string[]} */
  const problems = [];
  const lines = stripCode(readFileSync(full, 'utf8')).split('\n');
  /** @type {Map<string, number>} */
  const ids = new Map();
  let tables = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const header = lines[i] ?? '';
    if (!header.trim().startsWith('|') || !/^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? '')) continue;
    const cols = splitRow(header);
    const stageCol = cols.indexOf(THREAT_STAGE_COLUMN);
    const idCol = cols.indexOf('ID');
    if (stageCol >= 0) tables += 1;
    let j = i + 2;
    for (; j < lines.length && (lines[j] ?? '').trim().startsWith('|'); j += 1) {
      if (stageCol < 0) continue;
      const cells = splitRow(lines[j] ?? '');
      const where = `${THREAT_FILE}:${j + 1}`;
      const value = cells[stageCol] ?? '';
      if (!isStageCell(value)) {
        problems.push(
          `${where}: '${THREAT_STAGE_COLUMN}' must be stage IDs only (SNN, SNN) or '수용: <reason>'`,
        );
      }
      if (idCol < 0) continue;
      const id = cells[idCol] ?? '';
      const prev = ids.get(id);
      if (id === '') problems.push(`${where}: threat row without ID`);
      else if (prev !== undefined)
        problems.push(`${where}: duplicate threat ID ${id} (also line ${prev})`);
      else ids.set(id, j + 1);
    }
    i = j - 1;
  }
  if (tables === 0)
    problems.push(`${THREAT_FILE}: no threat table with a '${THREAT_STAGE_COLUMN}' column`);
  return problems;
}

/**
 * @param {string} root
 * @param {string[]} required repo-relative paths; '*' in the file name matches any characters
 * @returns {string[]} problems
 */
export function checkRequiredFiles(root, required) {
  /** @type {string[]} */
  const problems = [];
  for (const rel of required) {
    const dir = path.join(root, ...path.posix.dirname(rel).split('/'));
    const pattern = path.posix
      .basename(rel)
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    const re = new RegExp(`^${pattern}$`);
    const found = existsSync(dir) && readdirSync(dir).some((name) => re.test(name));
    if (!found) problems.push(`${rel}: required file is missing`);
  }
  return problems;
}

/**
 * @param {string} [root]
 * @param {{ requiredFiles?: string[] }} [options]
 * @returns {string[]} all problems
 */
export function checkDocs(root = DEFAULT_ROOT, options = {}) {
  /** @type {string[]} */
  const problems = [];
  const stageIds = readStageIds(root);
  const adrNumbers = listAdrNumbers(root);
  for (const file of listMarkdown(root)) {
    const text = readFileSync(path.join(root, file), 'utf8');
    problems.push(...checkLinks(root, file, text));
    if (stageIds !== null) problems.push(...checkStageRefs(file, text, stageIds));
    problems.push(...checkAdrRefs(file, text, adrNumbers), ...checkMermaid(file, text));
  }
  problems.push(...checkAdrs(root), ...checkStatuses(root), ...checkThreatModel(root));
  problems.push(...checkRequiredFiles(root, options.requiredFiles ?? []));
  return problems;
}

function isMain() {
  const arg = process.argv[1];
  if (arg === undefined) return false;
  const norm = (/** @type {string} */ p) =>
    process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
  return (
    norm(fileURLToPath(import.meta.url)) === norm(arg) ||
    import.meta.url === pathToFileURL(arg).href
  );
}

if (isMain()) {
  const problems = checkDocs(DEFAULT_ROOT);
  if (problems.length > 0) {
    process.stderr.write(
      `check-docs: ${problems.length} problem(s)\n${problems.map((p) => `  - ${p}`).join('\n')}\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write('check-docs: OK\n');
  }
}

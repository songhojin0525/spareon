#!/usr/bin/env node
// @ts-check
// Lists every `SKELETON(SNN): <what replaces it>` marker in the code, grouped by the stage that replaces
// it (CLAUDE.md: unfinished stand-ins carry this marker; v0.1 needs zero, docs/MVP.md).
//
//   node scripts/check-skeleton.mjs                     list markers; exit 1 on malformed markers
//   node scripts/check-skeleton.mjs --expect REPORT.md  also require the report's 교체 목록 table to list
//                                                       exactly the same (file, stage) pairs
//   node scripts/check-skeleton.mjs --max 0             fail when there are more than N markers (S32)
//
// A marker is the text `SKELETON(` in a code file. Well-formed: `SKELETON(S05): text` or
// `SKELETON(S06, S08): text`, every stage present in prompts/STAGES.md, and a non-empty description.
// Markdown is not scanned (documents talk about markers; only code carries them).
// Dependency-free on purpose (Node built-ins only).

import { readdirSync, readFileSync } from 'node:fs';
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
  'testdata',
]);
export const CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '.go',
  '.sql',
  '.ps1',
  '.sh',
  '.cmd',
  '.yaml',
  '.yml',
]);
/** This script and its tests describe the marker format; they are not markers. */
const SELF = new Set([
  'scripts/check-skeleton.mjs',
  'tools/repo-checks/test/check-skeleton.test.ts',
  // Fixture text for the stage-reference check of check-docs (an invalid stage on purpose).
  'tools/repo-checks/test/check-docs.test.ts',
]);
const MARKER_RE = /SKELETON\(([^)]*)\)(:?)\s*(.*)$/;
const STAGE_LIST_RE = /^S\d{2}(?:, S\d{2})*$/;

/**
 * @typedef {{ file: string, line: number, stages: string[], text: string }} Marker
 * @typedef {{ markers: Marker[], problems: string[] }} ScanResult
 */

/** @param {string} root */
function readStageIds(root) {
  try {
    const text = readFileSync(path.join(root, 'prompts', 'STAGES.md'), 'utf8');
    return new Set([...text.matchAll(/^\|\s*(S\d{2})\s*\|/gm)].map((m) => m[1] ?? ''));
  } catch {
    return null;
  }
}

/**
 * @param {string} root
 * @param {string} [dir]
 * @returns {string[]} code files relative to root, '/'-separated, sorted
 */
export function listCodeFiles(root, dir = '') {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = dir === '' ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...listCodeFiles(root, rel));
    } else if (CODE_EXTENSIONS.has(path.extname(entry.name)) && !SELF.has(rel)) {
      out.push(rel);
    }
  }
  return out.sort();
}

/**
 * Parse the markers of one file's text.
 * @param {string} file
 * @param {string} text
 * @param {Set<string> | null} stageIds
 * @returns {ScanResult}
 */
export function parseMarkers(file, text, stageIds) {
  /** @type {Marker[]} */
  const markers = [];
  /** @type {string[]} */
  const problems = [];
  text.split(/\r?\n/).forEach((lineText, i) => {
    if (!lineText.includes('SKELETON(')) return;
    const where = `${file}:${i + 1}`;
    const m = MARKER_RE.exec(lineText);
    const list = m?.[1] ?? '';
    if (m === null || !STAGE_LIST_RE.test(list)) {
      problems.push(`${where}: malformed marker (expected "SKELETON(SNN): <what replaces it>")`);
      return;
    }
    const stages = list.split(', ');
    if (m[2] !== ':' || (m[3] ?? '').trim() === '') {
      problems.push(`${where}: marker needs ": <what replaces it>"`);
    }
    for (const s of stages) {
      if (stageIds !== null && !stageIds.has(s)) problems.push(`${where}: unknown stage ${s}`);
    }
    markers.push({ file, line: i + 1, stages, text: (m[3] ?? '').trim() });
  });
  return { markers, problems };
}

/**
 * @param {string} root
 * @returns {ScanResult}
 */
export function scanSkeletons(root = DEFAULT_ROOT) {
  const stageIds = readStageIds(root);
  /** @type {ScanResult} */
  const result = { markers: [], problems: [] };
  for (const file of listCodeFiles(root)) {
    const text = readFileSync(path.join(root, file), 'utf8');
    const r = parseMarkers(file, text, stageIds);
    result.markers.push(...r.markers);
    result.problems.push(...r.problems);
  }
  return result;
}

/**
 * (file, stage) pairs from the 교체 목록 table of a report: the first Markdown table after a heading that
 * contains "교체 목록", with columns that include "파일" and "대체 차수".
 * @param {string} reportText
 * @returns {Set<string> | null} null when the table is missing
 */
export function readReplacementTable(reportText) {
  const lines = reportText.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#+ .*교체 목록/.test(l));
  if (start < 0) return null;
  /** @type {string[] | null} */
  let header = null;
  /** @type {Set<string>} */
  const pairs = new Set();
  for (const line of lines.slice(start + 1)) {
    if (/^#+ /.test(line)) break;
    if (!line.trim().startsWith('|')) {
      if (header !== null) break;
      continue;
    }
    const cells = line
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((c) => c.trim());
    if (header === null) {
      header = cells;
      continue;
    }
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    const fileCol = header.findIndex((h) => h.includes('파일'));
    const stageCol = header.findIndex((h) => h.includes('대체 차수'));
    if (fileCol < 0 || stageCol < 0) return null;
    const file = (cells[fileCol] ?? '').replace(/`/g, '').replace(/:\d+$/, '');
    for (const s of (cells[stageCol] ?? '').match(/S\d{2}/g) ?? []) pairs.add(`${file} ${s}`);
  }
  return header === null ? null : pairs;
}

/**
 * @param {Marker[]} markers
 * @param {Set<string>} table
 * @returns {string[]} differences
 */
export function compareWithTable(markers, table) {
  const code = new Set(markers.flatMap((m) => m.stages.map((s) => `${m.file} ${s}`)));
  /** @type {string[]} */
  const problems = [];
  for (const p of [...code].sort()) {
    if (!table.has(p)) problems.push(`in code but not in the report table: ${p}`);
  }
  for (const p of [...table].sort()) {
    if (!code.has(p)) problems.push(`in the report table but not in code: ${p}`);
  }
  return problems;
}

/** @param {Marker[]} markers */
export function formatMarkers(markers) {
  /** @type {Map<string, Marker[]>} */
  const byStage = new Map();
  for (const m of markers) {
    for (const s of m.stages) byStage.set(s, [...(byStage.get(s) ?? []), m]);
  }
  const lines = [];
  for (const s of [...byStage.keys()].sort()) {
    const list = byStage.get(s) ?? [];
    lines.push(`${s} (${list.length})`);
    for (const m of list) lines.push(`  ${m.file}:${m.line}  ${m.text}`);
  }
  return lines.join('\n');
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
  const args = process.argv.slice(2);
  /** @type {string | undefined} */
  let expect;
  /** @type {number | undefined} */
  let max;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--expect') expect = args[++i];
    else if (args[i] === '--max') max = Number.parseInt(args[++i] ?? '', 10);
    else {
      process.stderr.write(
        `usage: node scripts/check-skeleton.mjs [--expect REPORT.md] [--max N]\n`,
      );
      process.exit(2);
    }
  }
  const { markers, problems } = scanSkeletons(DEFAULT_ROOT);
  process.stdout.write(`${formatMarkers(markers)}\nSKELETON markers: ${markers.length}\n`);
  if (expect !== undefined) {
    const table = readReplacementTable(readFileSync(path.resolve(expect), 'utf8'));
    if (table === null)
      problems.push(`${expect}: no "교체 목록" table with 파일 and 대체 차수 columns`);
    else problems.push(...compareWithTable(markers, table));
  }
  if (max !== undefined && (Number.isNaN(max) || markers.length > max)) {
    problems.push(`${markers.length} markers > --max ${String(max)}`);
  }
  if (problems.length > 0) {
    process.stderr.write(
      `check-skeleton: ${problems.length} problem(s)\n${problems.map((p) => `  - ${p}`).join('\n')}\n`,
    );
    process.exitCode = 1;
  }
}

#!/usr/bin/env node
// @ts-check
// Documentation checks (initial version, later stages extend it). Exit code 1 on any problem.
//   1. Relative Markdown links point to files that exist.
//   2. ADRs (docs/adr/NNNN-*.md) have unique 4-digit numbers, a title and the required sections.
//   3. PROGRESS.md stage rows and stage REPORT.md files use only the allowed status values.
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
      if (!existsSync(resolved)) problems.push(`${file}:${i + 1}: broken link -> ${target}`);
    }
  });
  return problems;
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
    readFileSync(progress, 'utf8')
      .split(/\r?\n/)
      .forEach((line, i) => {
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
 * @param {string} [root]
 * @returns {string[]} all problems
 */
export function checkDocs(root = DEFAULT_ROOT) {
  /** @type {string[]} */
  const problems = [];
  for (const file of listMarkdown(root)) {
    problems.push(...checkLinks(root, file, readFileSync(path.join(root, file), 'utf8')));
  }
  problems.push(...checkAdrs(root), ...checkStatuses(root));
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
  const problems = checkDocs();
  if (problems.length > 0) {
    process.stderr.write(
      `check-docs: ${problems.length} problem(s)\n${problems.map((p) => `  - ${p}`).join('\n')}\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write('check-docs: OK\n');
  }
}

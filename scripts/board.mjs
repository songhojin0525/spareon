#!/usr/bin/env node
// 진행 상황 보드 (의존성 없음, Node 18+). 읽기만 하고 어떤 파일도 고치지 않는다.
//
//   node scripts/board.mjs                 터미널 보드 (2초마다 갱신, q 또는 Ctrl+C로 종료)
//   node scripts/board.mjs --web           웹 보드 http://127.0.0.1:4545 (이 컴퓨터에서만 열림)
//   node scripts/board.mjs --web --open    웹 보드를 띄우고 브라우저도 연다
//   node scripts/board.mjs --web --lan     같은 와이파이의 휴대폰에서도 열 수 있게 (비밀 주소가 출력됨)
//   node scripts/board.mjs --once          한 번만 출력하고 끝 (/status 명령, 로그용)
//   node scripts/board.mjs --json          상태를 JSON으로 출력
// 옵션: --port 4545  --interval 2  --ascii (막대·표시가 깨져 보이면)  --no-color  --rows 40 --cols 100 (--once 크기)
//
// 읽는 것: prompts/STAGES.md(차수 목록·의존), PROGRESS.md(공식 상태), .runner/board/*.json(실시간 진행률),
//          .runner/events.jsonl(활동 기록), .runner/STATUS, HUMAN_TODO.md, git log

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = (...p) => path.join(ROOT, ...p);
const STALE_MIN = 40; // 진행 중인데 이만큼 상태 기록도 커밋도 없으면 '멈춘 듯' 표시 (한도 도달·창 닫힘 등). 적대적 검토는 30분 넘게 조용할 수 있다
const SIZE_WEIGHT = { S: 1, M: 1, L: 2, XL: 3 };
const FINAL = new Set(['DONE', 'DONE_NEEDS_HUMAN', 'BLOCKED']);

// ───────────────────────── 옵션 ─────────────────────────
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const opt = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
if (has('--help') || has('-h')) {
  const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  console.log(src.filter((l) => l.startsWith('//')).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

// ───────────────────────── 읽기 ─────────────────────────
function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  } catch {
    return null;
  }
}

function tableRows(md, firstHeader) {
  // firstHeader로 시작하는 표의 데이터 행만 돌려준다.
  if (!md) return [];
  const lines = md.split(/\r?\n/);
  const out = [];
  let inTable = false;
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('|')) {
      if (inTable) break;
      continue;
    }
    const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (!inTable) {
      if (cells[0] === firstHeader) inTable = true;
      continue;
    }
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) continue;
    out.push(cells);
  }
  return out;
}

function loadStages() {
  return tableRows(readText(P('prompts', 'STAGES.md')), 'ID')
    .filter((c) => /^S\d{2}$/.test(c[0]))
    .map((c) => ({
      id: c[0],
      file: c[1],
      name: c[2],
      deps: (c[3].match(/S\d{2}/g) || []),
      model: c[4],
      size: c[5],
      human: c[6] || '',
    }));
}

function loadProgress() {
  const map = {};
  for (const c of tableRows(readText(P('PROGRESS.md')), '차수')) {
    if (!/^S\d{2}$/.test(c[0])) continue;
    const raw = c[1] || 'TODO';
    const m = raw.toUpperCase().match(/DONE_NEEDS_HUMAN|IN_PROGRESS|DONE|BLOCKED|TODO/);
    map[c[0]] = {
      status: m ? m[0] : 'TODO',
      statusRaw: raw,
      start: c[2] || '',
      end: c[3] || '',
      checkpoint: c[5] || '',
      summary: c[6] || '',
    };
  }
  return map;
}

function loadLive() {
  const map = {};
  let files = [];
  try {
    files = fs.readdirSync(P('.runner', 'board')).filter((f) => /^S\d{2}\.json$/.test(f));
  } catch {
    return map;
  }
  for (const f of files) {
    try {
      const s = JSON.parse(readText(P('.runner', 'board', f)));
      if (s && /^S\d{2}$/.test(s.id)) map[s.id] = s;
    } catch {
      /* 쓰는 도중이면 다음 갱신 때 읽는다 */
    }
  }
  return map;
}

function loadEvents(limit = 40) {
  const file = P('.runner', 'events.jsonl');
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 128 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    if (len < size) lines.shift(); // 잘린 첫 줄 버림
    const out = [];
    for (const l of lines) {
      if (!l.trim()) continue;
      try {
        const e = JSON.parse(l);
        if (e && e.t) out.push({ t: e.t, stage: e.stage ?? null, kind: String(e.kind ?? ''), text: String(e.text ?? ''), worker: e.worker ?? null });
      } catch {
        /* 깨진 줄 무시 */
      }
    }
    return out.slice(-limit);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function loadTodos() {
  const md = readText(P('HUMAN_TODO.md'));
  if (!md) return { open: [], done: 0 };
  const open = [];
  let done = 0;
  for (const line of md.split(/\r?\n/)) {
    const m = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/);
    if (!m) continue;
    if (m[1] === ' ') open.push(m[2].replace(/\*\*/g, '').replace(/`/g, '').trim());
    else done++;
  }
  return { open, done };
}

let gitCache = { at: 0, commits: [] };
function loadCommits() {
  if (Date.now() - gitCache.at < 10_000) return gitCache.commits;
  let commits = [];
  try {
    const out = execFileSync('git', ['log', '-n', '6', '--pretty=format:%h%x09%cI%x09%s'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    commits = out.split('\n').filter(Boolean).map((l) => {
      const [hash, t, ...s] = l.split('\t');
      return { hash, t, subject: s.join('\t') };
    });
  } catch {
    commits = [];
  }
  gitCache = { at: Date.now(), commits };
  return commits;
}

function mtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

// ───────────────────────── 상태 합치기 ─────────────────────────
function mergeStatus(prog, live) {
  const p = prog?.status ?? 'TODO';
  const l = live?.status;
  if (!l) return p;
  if (l === 'IN_PROGRESS') return p === 'DONE' || p === 'DONE_NEEDS_HUMAN' ? p : 'IN_PROGRESS';
  if (FINAL.has(l)) return p === 'TODO' || p === 'IN_PROGRESS' ? l : p;
  return p;
}

const PHASE_LABEL = { plan: 'plan', build: 'build', gate: 'gate', review: 'review', report: 'report', extend: 'extend' };

function buildState() {
  const now = Date.now();
  const stages = loadStages();
  const prog = loadProgress();
  const live = loadLive();
  // A commit is also a sign of life: long review/fix phases often commit without a status record.
  const lastCommitMs = Math.max(0, ...loadCommits().map((c) => Date.parse(c.t) || 0));
  const byId = {};
  const rows = stages.map((s) => {
    const pr = prog[s.id];
    const lv = live[s.id];
    const status = mergeStatus(pr, lv);
    const r = {
      id: s.id,
      name: s.name,
      deps: s.deps,
      model: s.model,
      size: s.size,
      human: s.human,
      status,
      statusRaw: pr?.statusRaw ?? status,
      phase: status === 'IN_PROGRESS' ? lv?.phase ?? null : null,
      phaseLabel: status === 'IN_PROGRESS' && lv?.phase ? PHASE_LABEL[lv.phase] ?? lv.phase : '',
      checkpoints: lv?.checkpoints ?? null,
      percent: FINAL.has(status) && status !== 'BLOCKED' ? 100 : status === 'IN_PROGRESS' ? lv?.percent ?? 3 : status === 'BLOCKED' ? lv?.percent ?? 0 : 0,
      activity: status === 'IN_PROGRESS' ? lv?.activity || pr?.checkpoint || '' : '',
      summary: (FINAL.has(status) ? lv?.summary || pr?.summary : pr?.summary) || '',
      worker: lv?.worker ?? 'main',
      startedAt: lv?.startedAt ?? null,
      finishedAt: lv?.finishedAt ?? null,
      updatedAt: lv?.updatedAt ?? null,
      startText: pr?.start ?? '',
      endText: pr?.end ?? '',
      attempts: lv?.attempts ?? 0,
      stale: false,
      waitingOn: [],
      ready: false,
    };
    if (status === 'IN_PROGRESS' && r.updatedAt) r.stale = now - Math.max(Date.parse(r.updatedAt), lastCommitMs) > STALE_MIN * 60_000;
    byId[s.id] = r;
    return r;
  });
  for (const r of rows) {
    if (r.status !== 'TODO') continue;
    r.waitingOn = r.deps.filter((d) => !['DONE', 'DONE_NEEDS_HUMAN'].includes(byId[d]?.status));
    r.ready = r.waitingOn.length === 0;
  }

  let wTotal = 0;
  let wDone = 0;
  const counts = { DONE: 0, DONE_NEEDS_HUMAN: 0, IN_PROGRESS: 0, BLOCKED: 0, TODO: 0, ready: 0 };
  for (const r of rows) {
    const w = SIZE_WEIGHT[r.size] ?? 1;
    wTotal += w;
    wDone += (w * (r.status === 'BLOCKED' ? 0 : r.percent)) / 100;
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    if (r.ready) counts.ready++;
  }

  const events = loadEvents(40);
  const runnerStatus = (readText(P('.runner', 'STATUS')) || '').trim().split(/\r?\n/)[0] || '';
  const lastActivity = Math.max(
    mtime(P('.runner', 'events.jsonl')),
    ...Object.keys(live).map((id) => mtime(P('.runner', 'board', `${id}.json`))),
    0,
  );
  const running = rows.filter((r) => r.status === 'IN_PROGRESS');
  let runner;
  if (running.some((r) => !r.stale)) runner = { state: 'working', label: 'leading' };
  else if (running.length) runner = { state: 'stalled', label: '멈춘 듯 — 한도 도달이나 창 닫힘일 수 있어요. 한도가 풀리면 /resume' };
  else if (/^STOP/i.test(runnerStatus)) runner = { state: 'stopped', label: `stopped · ${runnerStatus.replace(/^STOP:?\s*/i, '') || 'no reason given'}` };
  else if (counts.TODO + counts.IN_PROGRESS === 0) runner = { state: 'finished', label: 'all stages complete' };
  else runner = { state: 'idle', label: 'idle · start with /run or the script' };

  const todos = loadTodos();
  return {
    now: new Date(now).toISOString(),
    project: path.basename(ROOT),
    overall: wTotal ? Math.round((100 * wDone) / wTotal) : 0,
    counts,
    total: rows.length,
    runner: { ...runner, lastActivity: lastActivity ? new Date(lastActivity).toISOString() : null, statusFile: runnerStatus },
    workers: running.map((r) => ({ worker: r.worker, stage: r.id, name: r.name, percent: r.percent, phaseLabel: r.phaseLabel, stale: r.stale })),
    stages: rows,
    events: events.reverse(),
    todos: { open: todos.open.slice(0, 12), openCount: todos.open.length, done: todos.done },
    commits: loadCommits(),
    hasStages: rows.length > 0,
  };
}

// ───────────────────────── 시간 표시 ─────────────────────────
const pad2 = (n) => String(n).padStart(2, '0');
function hhmm(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function ago(iso) {
  if (!iso) return '';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}
function agoEn(iso) {
  if (!iso) return '';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function dur(fromIso, toIso) {
  if (!fromIso) return '';
  const s = Math.max(0, Math.round(((toIso ? Date.parse(toIso) : Date.now()) - Date.parse(fromIso)) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}시간 ${m}분` : `${m}분`;
}

// ───────────────────────── 터미널 ─────────────────────────
const ASCII = has('--ascii') || process.env.BOARD_ASCII === '1';
const COLOR = !has('--no-color') && !process.env.NO_COLOR && (process.stdout.isTTY || has('--color'));
const C = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = C('2');
const bold = C('1');
const green = C('32');
const yellow = C('33');
const red = C('31');
const cyan = C('36');
const magenta = C('35');
const gray = C('90');

function charWidth(cp) {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp >= 0x300 && cp <= 0x36f) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2;
  return 1;
}
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
function width(s) {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch.codePointAt(0));
  return w;
}
function fit(s, w) {
  // 표시 폭 w에 맞춰 자르거나 공백으로 채운다 (ANSI 없는 문자열에만 사용)
  s = String(s ?? '');
  let out = '';
  let cur = 0;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0));
    if (cur + cw > w) {
      if (w >= 2) {
        while (cur + 2 > w && out) {
          const last = [...out].pop();
          out = out.slice(0, -last.length);
          cur -= charWidth(last.codePointAt(0));
        }
        return out + '..' + ' '.repeat(Math.max(0, w - cur - 2));
      }
      return out + ' '.repeat(w - cur);
    }
    out += ch;
    cur += cw;
  }
  return out + ' '.repeat(Math.max(0, w - cur));
}
function bar(pct, w, color) {
  const full = ASCII ? '#' : '█';
  const empty = ASCII ? '-' : '░';
  const n = Math.round((Math.max(0, Math.min(100, pct)) / 100) * w);
  return color(full.repeat(n)) + gray(empty.repeat(w - n));
}

const CHIP = {
  DONE: { t: 'done', c: green },
  DONE_NEEDS_HUMAN: { t: '확인필요', c: yellow },
  IN_PROGRESS: { t: 'running', c: cyan },
  BLOCKED: { t: 'BLOCKED', c: red },
  READY: { t: 'ready', c: magenta },
  WAIT: { t: 'waiting', c: gray },
};
function chipOf(r) {
  if (r.status === 'TODO') return r.ready ? CHIP.READY : CHIP.WAIT;
  return CHIP[r.status] ?? CHIP.WAIT;
}

function stageLine(r, cols) {
  const chip = chipOf(r);
  const nameW = Math.max(14, Math.min(34, cols - 62));
  const barW = cols >= 90 ? 12 : 8;
  let detail = '';
  if (r.status === 'IN_PROGRESS') {
    const cp = r.checkpoints?.total ? ` ${r.checkpoints.done}/${r.checkpoints.total}` : '';
    detail = `${r.phaseLabel || 'run'}${cp}${r.activity ? ' · ' + r.activity : ''}`;
    if (r.stale) detail = `멈춘 듯 (${ago(r.updatedAt)}) · ` + detail;
  } else if (r.status === 'TODO') detail = r.ready ? `${r.model} · ${r.size}` : `needs ${r.waitingOn.join(', ')}`;
  else detail = r.summary || r.statusRaw;
  const pct = r.status === 'TODO' ? '    ' : `${String(r.percent).padStart(3)}%`;
  const used = 1 + 3 + 1 + nameW + 1 + barW + 1 + 4 + 1 + 8 + 1;
  const detailW = Math.max(0, cols - used - 1);
  const color = r.status === 'BLOCKED' ? red : r.status === 'DONE_NEEDS_HUMAN' ? yellow : r.status === 'IN_PROGRESS' ? (r.stale ? yellow : cyan) : green;
  const id = r.status === 'IN_PROGRESS' ? bold(cyan(r.id)) : r.status === 'TODO' ? gray(r.id) : r.id;
  const name = r.status === 'TODO' && !r.ready ? gray(fit(r.name, nameW)) : fit(r.name, nameW);
  return ` ${id} ${name} ${r.status === 'TODO' ? gray((ASCII ? '.' : '·').repeat(barW)) : bar(r.percent, barW, color)} ${pct} ${chip.c(fit(chip.t, 8))} ${dim(fit(detail, detailW))}`;
}

function renderTerminal(st, cols, rows) {
  cols = Math.max(60, Math.min(cols || 100, 160));
  const L = [];
  const hr = gray((ASCII ? '-' : '─').repeat(cols));
  const nowTxt = `${hhmm(st.now)} · q quit`;
  L.push(` ${bold(cyan('BINJARI'))} ${gray('// mission control · ' + st.project)}` + ' '.repeat(Math.max(1, cols - 4 - width('BINJARI // mission control · ' + st.project) - width(nowTxt))) + gray(nowTxt));
  if (!st.hasStages) {
    L.push(red(' prompts/STAGES.md를 찾지 못했습니다. 저장소 맨 위 폴더에서 실행하세요.'));
    return L.join('\n');
  }
  const c = st.counts;
  L.push(` overall ${bar(st.overall, 24, green)} ${bold(st.overall + '%')}  ${green('done ' + (c.DONE + c.DONE_NEEDS_HUMAN) + '/' + st.total)}${c.DONE_NEEDS_HUMAN ? yellow(` (확인필요 ${c.DONE_NEEDS_HUMAN})`) : ''} · ${cyan('running ' + c.IN_PROGRESS)} · ${c.BLOCKED ? red('blocked ' + c.BLOCKED) : 'blocked 0'} · left ${c.TODO}`);
  const rc = st.runner.state === 'working' ? cyan : st.runner.state === 'stalled' ? yellow : st.runner.state === 'finished' ? green : gray;
  L.push(` orchestrator ${rc((ASCII ? '* ' : '● ') + st.runner.label)}${st.runner.lastActivity ? gray(' · last activity ' + agoEn(st.runner.lastActivity)) : ''}`);
  if (st.workers.length) {
    L.push(' workers      ' + st.workers.map((w) => `${w.worker}${gray(' › ')}${cyan(w.stage)} ${w.percent}%${w.stale ? yellow(' (멈춘 듯)') : ''}`).join(gray('  |  ')));
  }
  L.push(hr);

  // 차수 목록: 화면이 작으면 끝난 차수와 먼 대기 차수를 접는다
  const head = L.length;
  const reserveBottom = Math.min(12, Math.max(5, Math.floor((rows || 40) / 3)));
  const budget = Math.max(6, (rows || 60) - head - reserveBottom - 1);
  let list = st.stages.map((r) => ({ r }));
  if (list.length > budget) {
    const doneRows = list.filter((x) => x.r.status === 'DONE');
    if (doneRows.length > 1) {
      const ids = doneRows.map((x) => x.r.id);
      list = list.filter((x) => x.r.status !== 'DONE');
      list.unshift({ text: ' ' + green(`done ×${ids.length} `) + gray(ids.length > 6 ? `${ids[0]}${ASCII ? '..' : '…'}${ids[ids.length - 1]}` : ids.join(' ')) });
    }
  }
  if (list.length > budget) {
    const keep = [];
    const hidden = [];
    let waitShown = 0;
    for (const x of list) {
      if (x.r && x.r.status === 'TODO' && !x.r.ready) {
        if (waitShown < 3) {
          keep.push(x);
          waitShown++;
        } else hidden.push(x.r.id);
      } else keep.push(x);
    }
    list = keep;
    if (hidden.length) list.push({ text: ' ' + gray(`+${hidden.length} waiting (${hidden[0]}${ASCII ? '..' : '…'}${hidden[hidden.length - 1]})`) });
  }
  for (const x of list) L.push(x.text ?? stageLine(x.r, cols));
  L.push(hr);

  const room = Math.max(3, (rows || 60) - L.length - 1);
  const todoN = Math.min(st.todos.open.length, 3);
  const evN = Math.max(2, room - (todoN ? todoN + 1 : 0) - 1);
  L.push(` ${bold('activity')}`);
  if (!st.events.length) L.push(gray('  no events yet — they appear once a stage starts'));
  for (const e of st.events.slice(0, evN)) {
    const who = e.stage ? cyan(e.stage) : magenta('orc');
    const color = e.kind === 'finish' ? (/BLOCKED/.test(e.text) ? red : green) : e.kind === 'checkpoint' ? (s) => s : dim;
    L.push(`  ${gray(hhmm(e.t))} ${who} ${color(fit(e.text, cols - 14))}`);
  }
  if (todoN) {
    L.push(` ${bold('사람이 할 일')} ${gray(`(${st.todos.openCount}개 중 ${todoN}개)`)}`);
    for (const t of st.todos.open.slice(0, todoN)) L.push(`  ${yellow(ASCII ? '[ ]' : '□')} ${fit(t, cols - 7)}`);
  }
  return L.slice(0, Math.max(10, rows || L.length)).map((l) => l.replace(/\s+$/, '')).join('\n');
}

function runTerminal() {
  const interval = Math.max(1, Number(opt('--interval', 2))) * 1000;
  if (has('--once') || !process.stdout.isTTY) {
    const cols = Number(opt('--cols', process.stdout.columns || 110));
    const rows = Number(opt('--rows', 60));
    process.stdout.write(renderTerminal(buildState(), cols, rows) + '\n');
    return;
  }
  const out = process.stdout;
  out.write('\x1b[?1049h\x1b[?25l');
  const restore = () => {
    out.write('\x1b[?25h\x1b[?1049l');
  };
  const quit = () => {
    restore();
    process.exit(0);
  };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
  process.on('exit', restore);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (d) => {
      const k = d.toString();
      if (k === 'q' || k === 'Q' || k === '\u0003' || k === '\u001b') quit();
      if (k === 'r' || k === 'R') draw();
    });
  }
  let last = '';
  function draw() {
    let frame;
    try {
      frame = renderTerminal(buildState(), out.columns, out.rows);
    } catch (e) {
      frame = red(` 보드 오류: ${e?.message ?? e}`);
    }
    if (frame === last) return;
    last = frame;
    out.write('\x1b[H\x1b[2J' + frame);
  }
  out.on('resize', () => {
    last = '';
    draw();
  });
  draw();
  setInterval(draw, interval);
}

// ───────────────────────── 웹 ─────────────────────────
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

function openBrowser(url) {
  try {
    const p =
      process.platform === 'win32'
        ? spawn('cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')], { detached: true, stdio: 'ignore', windowsHide: true })
        : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' });
    p.on('error', () => {});
    p.unref();
  } catch {
    /* 브라우저를 못 열어도 주소는 출력돼 있다 */
  }
}

function runWeb() {
  const lan = has('--lan');
  const host = lan ? '0.0.0.0' : '127.0.0.1';
  const token = lan ? crypto.randomBytes(12).toString('hex') : null;
  let port = Number(opt('--port', 4545));
  const pollMs = Math.max(1, Number(opt('--interval', 3))) * 1000;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, type, body, extra = {}) => {
      res.writeHead(code, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'X-Frame-Options': 'DENY',
        ...extra,
      });
      res.end(body);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'text/plain; charset=utf-8', '읽기 전용입니다');
    if (token) {
      const given = url.searchParams.get('t') || '';
      const ok = given.length === token.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
      if (!ok) return send(403, 'text/plain; charset=utf-8', '주소에 비밀 값(t=...)이 필요합니다. 터미널에 출력된 주소를 그대로 여세요.');
    }
    if (url.pathname === '/api/state') {
      try {
        return send(200, 'application/json; charset=utf-8', JSON.stringify(buildState()));
      } catch (e) {
        return send(500, 'application/json; charset=utf-8', JSON.stringify({ error: String(e?.message ?? e) }));
      }
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const nonce = crypto.randomBytes(16).toString('base64');
      return send(200, 'text/html; charset=utf-8', PAGE.replace(/__NONCE__/g, nonce).replace('__POLL__', String(pollMs)), {
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
    }
    if (url.pathname === '/favicon.ico') return send(204, 'text/plain', '');
    return send(404, 'text/plain; charset=utf-8', '없음');
  });

  let tries = 0;
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && tries < 10) {
      tries++;
      port++;
      server.listen(port, host);
    } else {
      console.error(`보드 서버를 열지 못했습니다: ${e.message}`);
      process.exit(1);
    }
  });
  server.on('listening', () => {
    const q = token ? `/?t=${token}` : '/';
    const local = `http://127.0.0.1:${port}${q}`;
    console.log(`\n  빈자리 진행 보드가 열렸습니다 (읽기 전용)\n`);
    console.log(`  이 컴퓨터:  ${local}`);
    if (lan) {
      for (const ip of lanAddresses()) console.log(`  휴대폰(같은 와이파이):  http://${ip}:${port}${q}`);
      console.log(`\n  주의: 이 주소를 아는 사람은 같은 네트워크에서 진행 상황을 볼 수 있습니다. 공용 와이파이에서는 쓰지 마세요.`);
    }
    console.log(`\n  끄려면 이 창에서 Ctrl+C\n`);
    if (has('--open')) openBrowser(local);
  });
  server.listen(port, host);
}

// ───────────────────────── 웹 페이지 ─────────────────────────
const PAGE = String.raw`<!doctype html>
<html lang="ko" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BINJARI · Mission Control</title>
<style nonce="__NONCE__">
:root,[data-theme="dark"]{
  --bg:#05070a;--bg2:#0a0e14;--panel:rgba(14,19,27,.82);--panel-solid:#0e131b;--line:#1b2330;--line2:#253042;
  --text:#e6edf6;--muted:#8a96a8;--faint:#4f5b6d;
  --acc:#3df0c2;--acc-dim:rgba(61,240,194,.14);
  --run:#4db8ff;--run-dim:rgba(77,184,255,.14);
  --done:#3ddc84;--done-dim:rgba(61,220,132,.13);
  --warn:#ffb547;--warn-dim:rgba(255,181,71,.14);
  --bad:#ff5d6c;--bad-dim:rgba(255,93,108,.14);
  --ready:#c792ff;--ready-dim:rgba(199,146,255,.14);
  --track:#141b26;--grid:rgba(120,150,190,.06);--glow:rgba(61,240,194,.10);
}
[data-theme="light"]{
  --bg:#f3f5f8;--bg2:#e9edf2;--panel:rgba(255,255,255,.9);--panel-solid:#fff;--line:#dde3ea;--line2:#c9d2dd;
  --text:#0d1520;--muted:#5a6676;--faint:#97a2b0;
  --acc:#0a9e7c;--acc-dim:rgba(10,158,124,.12);
  --run:#0a6fc2;--run-dim:rgba(10,111,194,.10);
  --done:#16884a;--done-dim:rgba(22,136,74,.10);
  --warn:#a76400;--warn-dim:rgba(167,100,0,.10);
  --bad:#c42a3a;--bad-dim:rgba(196,42,58,.10);
  --ready:#7a3fc0;--ready-dim:rgba(122,63,192,.10);
  --track:#e3e8ee;--grid:rgba(30,50,80,.05);--glow:rgba(10,158,124,.08);
}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{
  background:
    radial-gradient(1100px 500px at 15% -10%, var(--glow), transparent 60%),
    linear-gradient(var(--grid) 1px, transparent 1px) 0 0/28px 28px,
    linear-gradient(90deg, var(--grid) 1px, transparent 1px) 0 0/28px 28px,
    var(--bg);
  color:var(--text);
  font:14px/1.5 "JetBrains Mono","SF Mono","Cascadia Code","D2Coding",ui-monospace,Menlo,Consolas,monospace;
  -webkit-font-smoothing:antialiased;
}
.ko{font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Pretendard","Malgun Gothic","Noto Sans KR",system-ui,sans-serif}
.wrap{max-width:1240px;margin:0 auto;padding:18px 16px 56px}
.cap{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}

/* top bar */
.top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;border:1px solid var(--line);border-radius:12px;background:var(--panel);backdrop-filter:blur(6px)}
.brand{display:flex;align-items:center;gap:12px;min-width:0}
.logo{width:26px;height:26px;border-radius:7px;background:conic-gradient(from 210deg,var(--acc),var(--run),var(--ready),var(--acc));box-shadow:0 0 18px var(--acc-dim);flex:none;position:relative}
.logo::after{content:"";position:absolute;inset:6px;border-radius:3px;background:var(--bg)}
.brand b{font-size:15px;letter-spacing:.18em}
.brand .cap{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.live{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--muted);white-space:nowrap}
.pulse{width:8px;height:8px;border-radius:50%;background:var(--acc);box-shadow:0 0 0 0 var(--acc);animation:ping 1.8s infinite}
.pulse.off{background:var(--bad);animation:none}
@keyframes ping{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--acc) 70%,transparent)}80%{box-shadow:0 0 0 9px transparent}100%{box-shadow:0 0 0 0 transparent}}
.iconbtn{font:inherit;font-size:12px;color:var(--muted);background:transparent;border:1px solid var(--line2);border-radius:8px;padding:3px 9px;cursor:pointer}
.iconbtn:hover{color:var(--text);border-color:var(--muted)}

.warn{display:none;margin-top:12px;padding:12px 14px;border-radius:12px;border:1px solid color-mix(in srgb,var(--warn) 45%,transparent);background:var(--warn-dim);color:var(--warn);font-size:14px}
.warn.on{display:flex;gap:10px;align-items:flex-start}
.warn b{font-family:inherit}

.panel{margin-top:14px;border:1px solid var(--line);border-radius:14px;background:var(--panel);backdrop-filter:blur(6px);padding:16px}
.phead{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:12px}

/* hero */
.hero{display:grid;grid-template-columns:minmax(220px,300px) 1fr;gap:18px;align-items:stretch}
.big{font-size:64px;font-weight:700;line-height:1;letter-spacing:-.04em;font-variant-numeric:tabular-nums;background:linear-gradient(180deg,var(--text),color-mix(in srgb,var(--text) 55%,var(--acc)));-webkit-background-clip:text;background-clip:text;color:transparent}
.big small{font-size:28px;letter-spacing:0}
.hero .sub{color:var(--muted);font-size:12px;margin-top:8px}
.tiles{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px}
.tile{border:1px solid var(--line);border-radius:12px;padding:12px;background:var(--bg2);position:relative;overflow:hidden}
.tile::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--c,var(--faint))}
.tile .n{font-size:28px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--c,var(--text))}
.tile .l{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
.tile .l.ko{letter-spacing:0;text-transform:none;font-size:12px}

/* pipeline */
.pipe{display:grid;grid-template-columns:repeat(33,minmax(0,1fr));gap:4px;margin-top:16px}
.cell{height:30px;border-radius:5px;background:var(--track);border:1px solid var(--line);position:relative;cursor:default}
.cell.done{background:var(--done);border-color:transparent;opacity:.9}
.cell.human{background:var(--warn);border-color:transparent}
.cell.run{background:linear-gradient(90deg,var(--run) var(--p,0%),var(--run-dim) var(--p,0%));border-color:var(--run);box-shadow:0 0 14px var(--run-dim)}
.cell.run::after{content:"";position:absolute;inset:-3px;border-radius:7px;border:1px solid var(--run);opacity:.6;animation:ring 1.6s infinite}
.cell.stale{background:var(--warn-dim);border-color:var(--warn)}
.cell.bad{background:var(--bad);border-color:transparent}
.cell.ready{border-color:var(--ready);background:var(--ready-dim)}
@keyframes ring{0%{transform:scale(1);opacity:.7}100%{transform:scale(1.25);opacity:0}}
.groups{display:grid;grid-template-columns:repeat(33,minmax(0,1fr));gap:4px;margin-top:6px}
.groups span{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);border-top:1px solid var(--line2);padding-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* orchestrator */
.orch{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:13px}
.orch .node{display:inline-flex;align-items:center;gap:8px;padding:5px 10px;border:1px solid var(--line2);border-radius:999px;background:var(--bg2)}
.orch .dot{width:8px;height:8px;border-radius:50%;background:var(--faint)}
.dot.working{background:var(--acc);box-shadow:0 0 10px var(--acc)}
.dot.stalled{background:var(--warn)} .dot.stopped{background:var(--bad)} .dot.finished{background:var(--done)}
.orch .label{color:var(--muted)}
.workers{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:12px;margin-top:14px}
.worker{border:1px solid var(--line2);border-radius:12px;padding:12px 14px;background:linear-gradient(180deg,var(--run-dim),transparent 70%),var(--bg2)}
.worker.stale{background:linear-gradient(180deg,var(--warn-dim),transparent 70%),var(--bg2);border-color:color-mix(in srgb,var(--warn) 50%,transparent)}
.wtop{display:flex;justify-content:space-between;font-size:12px;color:var(--muted)}
.wtop b{color:var(--run);font-weight:600}
.wname{font-size:15px;font-weight:600;margin:6px 0 10px;display:flex;gap:8px;align-items:baseline}
.wname .id{color:var(--run)}
.wname .nm{font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",sans-serif;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wmeta{font-size:12px;color:var(--muted);margin-top:8px;display:flex;justify-content:space-between;gap:8px}
.empty{color:var(--faint);font-size:13px}

.bar{height:8px;border-radius:99px;background:var(--track);overflow:hidden;position:relative}
.bar>i{position:absolute;left:0;top:0;bottom:0;border-radius:99px;background:var(--c,var(--run))}
.bar.live>i{background-image:linear-gradient(45deg,rgba(255,255,255,.18) 25%,transparent 25%,transparent 50%,rgba(255,255,255,.18) 50%,rgba(255,255,255,.18) 75%,transparent 75%);background-size:14px 14px;animation:stripes .9s linear infinite}
@keyframes stripes{to{background-position:14px 0}}

/* stages */
.tabs{display:flex;gap:6px;flex-wrap:wrap}
.tabs button{font:inherit;font-size:12px;letter-spacing:.06em;color:var(--muted);background:transparent;border:1px solid var(--line2);border-radius:8px;padding:5px 11px;cursor:pointer}
.tabs button[aria-pressed="true"]{color:var(--bg);background:var(--acc);border-color:var(--acc)}
.rows{display:flex;flex-direction:column}
.row{display:grid;grid-template-columns:48px minmax(0,1.4fr) 74px minmax(90px,1fr) 46px 92px;gap:12px;align-items:center;padding:10px 4px;border-bottom:1px solid var(--line)}
.row:last-child{border-bottom:0}
.row .id{font-weight:700;color:var(--muted)}
.row.run .id{color:var(--run)} .row.bad .id{color:var(--bad)} .row.human .id{color:var(--warn)} .row.done .id{color:var(--done)} .row.ready .id{color:var(--ready)}
.row.wait{opacity:.5}
.row .nm{font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",sans-serif;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .det{grid-column:2 / -1;font-size:12px;color:var(--muted);margin-top:-6px;overflow-wrap:anywhere}
.row .det .ko{font-size:13px}
.tag{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);border:1px solid var(--line2);border-radius:6px;padding:1px 6px;text-align:center;white-space:nowrap}
.pct{font-size:12px;color:var(--muted);text-align:right;font-variant-numeric:tabular-nums}
.chip{font-size:11px;letter-spacing:.08em;text-transform:uppercase;font-weight:700;border-radius:6px;padding:3px 8px;text-align:center;white-space:nowrap}
.chip.ko{letter-spacing:0;text-transform:none;font-size:12px}
.c-done{color:var(--done);background:var(--done-dim)} .c-run{color:var(--run);background:var(--run-dim)} .c-bad{color:var(--bad);background:var(--bad-dim)}
.c-human{color:var(--warn);background:var(--warn-dim)} .c-ready{color:var(--ready);background:var(--ready-dim)} .c-wait{color:var(--faint);background:var(--track)}

/* bottom */
.cols{display:grid;grid-template-columns:1.25fr 1fr;gap:14px;align-items:start}
.feed{font-size:12.5px;max-height:440px;overflow:auto}
.ev{display:grid;grid-template-columns:44px 38px 14px 1fr;gap:6px;padding:4px 0}
.ev .t{color:var(--faint);font-variant-numeric:tabular-nums} .ev .s{color:var(--run);font-weight:700} .ev .s.orc{color:var(--ready)}
.ev .a{color:var(--faint)} .ev .x{color:var(--text);overflow-wrap:anywhere}
.ev.minor .x{color:var(--muted)} .ev.fin .x{color:var(--done)} .ev.blk .x{color:var(--bad)}
.todo{border-color:color-mix(in srgb,var(--warn) 40%,var(--line))}
.todo h3{margin:0;font-size:15px;color:var(--warn)}
.todo ul{list-style:none;margin:0;padding:0}
.todo li{display:grid;grid-template-columns:18px 1fr;gap:8px;padding:8px 0;border-bottom:1px dashed var(--line2);font-size:14px;line-height:1.55}
.todo li:last-child{border-bottom:0}
.todo li::before{content:"";width:12px;height:12px;border:1.5px solid var(--warn);border-radius:3px;margin-top:5px}
.commit{display:grid;grid-template-columns:70px 1fr auto;gap:8px;font-size:12.5px;padding:4px 0}
.commit code{color:var(--acc)} .commit .when{color:var(--faint)}

@media (max-width:900px){
  .hero{grid-template-columns:1fr}
  .tiles{grid-template-columns:repeat(3,minmax(0,1fr))}
  .cols{grid-template-columns:1fr}
  .pipe,.groups{gap:2px}
  .cell{height:22px;border-radius:3px}
  .groups span{font-size:8px;letter-spacing:0}
}
@media (max-width:620px){
  .big{font-size:52px}
  .tiles{grid-template-columns:repeat(5,minmax(0,1fr));gap:6px}
  .tile{padding:8px 6px 8px 9px}
  .tile .n{font-size:20px}
  .tile .l{font-size:9px;letter-spacing:.04em}
  .tile .l.ko{font-size:10px}
  .groups{display:none}
  .cols>div{order:-1}
  .row{grid-template-columns:42px minmax(0,1fr) 84px;gap:8px}
  .row .tag,.row .pct{display:none}
  .row .barc{grid-column:1 / -1;order:9}
  .row .det{grid-column:1 / -1;margin-top:0}
  .brand .cap{display:none}
}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <div class="brand"><span class="logo"></span><b>BINJARI</b><span class="cap" id="proj">mission control</span></div>
    <div class="live"><span class="pulse" id="pulse"></span><span id="clock">connecting…</span><button class="iconbtn" id="theme" type="button" title="Toggle theme">◐</button></div>
  </div>
  <div class="warn ko" id="warn"></div>

  <section class="panel">
    <div class="hero">
      <div>
        <div class="cap">overall progress</div>
        <div class="big" id="overall">–</div>
        <div class="sub">weighted by stage size · <span id="stagesCount"></span></div>
      </div>
      <div class="tiles" id="tiles"></div>
    </div>
    <div class="pipe" id="pipe" aria-label="Stage pipeline"></div>
    <div class="groups" id="groups"></div>
  </section>

  <section class="panel">
    <div class="phead"><span class="cap">orchestrator</span><span class="cap" id="lastAct"></span></div>
    <div class="orch" id="orch"></div>
    <div class="workers" id="workers"></div>
  </section>

  <section class="panel">
    <div class="phead">
      <span class="cap">stages</span>
      <div class="tabs" role="group" aria-label="Filter">
        <button type="button" data-f="focus">Focus</button>
        <button type="button" data-f="all">All</button>
        <button type="button" data-f="done">Done</button>
        <button type="button" data-f="human" class="ko">확인·막힘</button>
      </div>
    </div>
    <div class="rows" id="rows"></div>
  </section>

  <div class="cols">
    <section class="panel"><div class="phead"><span class="cap">activity log</span><span class="cap" id="evCount"></span></div><div class="feed" id="events"></div></section>
    <div>
      <section class="panel todo"><div class="phead"><h3 class="ko">사람이 할 일</h3><span class="cap" id="todoCount"></span></div><ul class="ko" id="todos"></ul></section>
      <section class="panel"><div class="phead"><span class="cap">recent commits</span></div><div id="commits"></div></section>
    </div>
  </div>
</div>
<script nonce="__NONCE__">
(function(){
  var POLL = __POLL__;
  var GROUPS = [['foundation',0,4],['server core',5,13],['buyer',14,16],['windows agent',17,22],['web',23,26],['ship',27,32]];
  var filter = 'focus', last = null;
  try { filter = localStorage.getItem('board.filter') || 'focus'; } catch (e) {}
  try { var th = localStorage.getItem('board.theme'); if (th) document.documentElement.setAttribute('data-theme', th); } catch (e) {}

  var $ = function(id){ return document.getElementById(id); };
  function el(tag, cls, text){ var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function clear(n){ while (n.firstChild) n.removeChild(n.firstChild); }
  function pad(n){ return (n < 10 ? '0' : '') + n; }
  function hhmm(iso){ if (!iso) return ''; var d = new Date(iso); return isNaN(d) ? '' : pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function ago(iso){ if (!iso) return ''; var s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (s < 60) return s + 's ago'; if (s < 3600) return Math.floor(s/60) + 'm ago'; if (s < 86400) return Math.floor(s/3600) + 'h ago'; return Math.floor(s/86400) + 'd ago'; }
  function dur(a, b){ if (!a) return ''; var s = Math.max(0, Math.round(((b ? Date.parse(b) : Date.now()) - Date.parse(a)) / 1000));
    var h = Math.floor(s/3600), m = Math.floor((s%3600)/60); return h ? h + 'h ' + m + 'm' : m + 'm'; }
  function kind(r){
    if (r.status === 'DONE') return 'done'; if (r.status === 'DONE_NEEDS_HUMAN') return 'human';
    if (r.status === 'IN_PROGRESS') return r.stale ? 'stale' : 'run'; if (r.status === 'BLOCKED') return 'bad';
    return r.ready ? 'ready' : 'wait';
  }
  var COLOR = { done:'var(--done)', human:'var(--warn)', run:'var(--run)', stale:'var(--warn)', bad:'var(--bad)', ready:'var(--ready)', wait:'var(--faint)' };
  function chip(r){
    var k = kind(r);
    if (k === 'human') return el('span', 'chip ko c-human', '확인 필요');
    if (k === 'stale') return el('span', 'chip ko c-human', '멈춘 듯');
    var map = { done:['c-done','done'], run:['c-run','running'], bad:['c-bad','blocked'], ready:['c-ready','ready'], wait:['c-wait','waiting'] };
    return el('span', 'chip ' + map[k][0], map[k][1]);
  }
  function bar(pct, color, live){ var b = el('div', 'bar' + (live ? ' live' : '')); var i = el('i'); i.style.width = Math.max(0, Math.min(100, pct)) + '%'; i.style.setProperty('--c', color); b.appendChild(i);
    b.setAttribute('role','progressbar'); b.setAttribute('aria-valuenow', String(pct)); b.setAttribute('aria-valuemin','0'); b.setAttribute('aria-valuemax','100'); return b; }
  function detail(r){
    var d = el('div', 'det');
    var k = kind(r);
    if (r.status === 'IN_PROGRESS') {
      var cp = r.checkpoints && r.checkpoints.total ? ' ' + r.checkpoints.done + '/' + r.checkpoints.total : '';
      if (r.stale) d.appendChild(el('span', 'ko', '마지막 기록 ' + ago(r.updatedAt) + ' — 한도 도달이나 창 닫힘일 수 있어요 · '));
      d.appendChild(document.createTextNode((r.phaseLabel || 'run') + cp + (r.startedAt ? ' · ' + dur(r.startedAt) + ' elapsed' : '') + (r.activity ? ' · ' : '')));
      if (r.activity) d.appendChild(el('span', 'ko', r.activity));
      return d;
    }
    if (r.status === 'TODO') { d.textContent = r.ready ? 'deps satisfied · recommended ' + r.model + ' · size ' + r.size : 'needs ' + r.waitingOn.join(', '); return d; }
    d.appendChild(el('span', 'ko', r.summary || r.statusRaw));
    if (r.startedAt && r.finishedAt) d.appendChild(document.createTextNode(' · took ' + dur(r.startedAt, r.finishedAt)));
    if (k === 'human' && r.human) d.appendChild(el('span', 'ko', ' · 사람: ' + r.human));
    return d;
  }
  function visible(r){
    if (filter === 'all') return true;
    if (filter === 'done') return r.status === 'DONE' || r.status === 'DONE_NEEDS_HUMAN';
    if (filter === 'human') return r.status === 'DONE_NEEDS_HUMAN' || r.status === 'BLOCKED';
    return r.status === 'IN_PROGRESS' || r.status === 'BLOCKED' || r.status === 'DONE_NEEDS_HUMAN' || r.ready;
  }
  function tile(n, label, color, ko){ var t = el('div', 'tile'); t.style.setProperty('--c', color); t.appendChild(el('div', 'n', String(n))); t.appendChild(el('div', 'l' + (ko ? ' ko' : ''), label)); return t; }

  function render(st){
    $('pulse').className = 'pulse';
    $('clock').textContent = 'LIVE · ' + hhmm(st.now) + ' · ' + (POLL/1000) + 's';
    $('proj').textContent = 'mission control · ' + st.project;
    var w = $('warn'); w.className = 'warn ko'; w.textContent = '';
    if (!st.hasStages) { w.textContent = '⚠ prompts/STAGES.md를 찾지 못했습니다. 저장소 맨 위 폴더에서 보드를 실행하세요.'; w.className = 'warn ko on'; }
    else if (st.runner.state === 'stalled') { w.textContent = '⚠ 진행 중인 차수의 기록이 한동안 멈췄어요. 사용량 한도에 걸렸거나 창이 닫혔을 수 있습니다. 한도가 풀리면 Claude Code에서 /resume 을 입력하세요.'; w.className = 'warn ko on'; }
    else if (st.counts.BLOCKED) { w.textContent = '⚠ 막힌 차수가 ' + st.counts.BLOCKED + '개 있어요. 해당 차수의 docs/stages/SNN/REPORT.md \'막힌 것\'을 확인하세요.'; w.className = 'warn ko on'; }

    var c = st.counts;
    $('overall').textContent = ''; $('overall').appendChild(document.createTextNode(String(st.overall))); $('overall').appendChild(el('small', null, '%'));
    $('stagesCount').textContent = (c.DONE + c.DONE_NEEDS_HUMAN) + ' / ' + st.total + ' stages';
    var tiles = $('tiles'); clear(tiles);
    tiles.appendChild(tile(c.DONE + c.DONE_NEEDS_HUMAN, 'done', 'var(--done)'));
    tiles.appendChild(tile(c.IN_PROGRESS, 'running', 'var(--run)'));
    tiles.appendChild(tile(c.DONE_NEEDS_HUMAN, '사람 확인', 'var(--warn)', true));
    tiles.appendChild(tile(c.BLOCKED, 'blocked', c.BLOCKED ? 'var(--bad)' : 'var(--faint)'));
    tiles.appendChild(tile(c.TODO, 'queued · ' + c.ready + ' ready', 'var(--ready)'));

    var pipe = $('pipe'); clear(pipe);
    st.stages.forEach(function(r){
      var k = kind(r); var cell = el('div', 'cell ' + k);
      if (k === 'run') cell.style.setProperty('--p', r.percent + '%');
      cell.title = r.id + ' ' + r.name + ' · ' + (k === 'human' ? '확인 필요' : k) + (r.status === 'IN_PROGRESS' ? ' ' + r.percent + '%' : '');
      pipe.appendChild(cell);
    });
    var groups = $('groups');
    if (!groups.firstChild) GROUPS.forEach(function(g){ var s = el('span', null, g[0]); s.style.gridColumn = (g[1] + 1) + ' / ' + (g[2] + 2); s.title = 'S' + pad(g[1]) + '–S' + pad(g[2]); groups.appendChild(s); });

    var orch = $('orch'); clear(orch);
    var n1 = el('span', 'node'); n1.appendChild(el('span', 'dot ' + st.runner.state)); n1.appendChild(el('b', null, 'orchestrator')); orch.appendChild(n1);
    orch.appendChild(el('span', 'label', 'you · ' + st.workers.length + (st.workers.length === 1 ? ' worker' : ' workers') + ' ·'));
    orch.appendChild(el('span', st.runner.state === 'stalled' ? 'ko' : null, st.runner.label));
    $('lastAct').textContent = st.runner.lastActivity ? 'last activity ' + ago(st.runner.lastActivity) : '';
    var ws = $('workers'); clear(ws);
    if (!st.workers.length) ws.appendChild(el('div', 'empty', 'no active workers'));
    st.workers.forEach(function(wk, i){
      var r = st.stages.filter(function(x){ return x.id === wk.stage; })[0] || {};
      var box = el('div', 'worker' + (wk.stale ? ' stale' : ''));
      var top = el('div', 'wtop'); var who = el('span'); who.appendChild(el('b', null, 'claude-' + (i + 1))); who.appendChild(document.createTextNode(' · ' + wk.worker)); top.appendChild(who); top.appendChild(el('span', null, wk.percent + '%')); box.appendChild(top);
      var nm = el('div', 'wname'); nm.appendChild(el('span', 'id', wk.stage)); nm.appendChild(el('span', 'nm', wk.name)); box.appendChild(nm);
      box.appendChild(bar(wk.percent, wk.stale ? 'var(--warn)' : 'var(--run)', !wk.stale));
      var meta = el('div', 'wmeta');
      var cp = r.checkpoints && r.checkpoints.total ? (r.phaseLabel || 'run') + ' ' + r.checkpoints.done + '/' + r.checkpoints.total : (r.phaseLabel || 'run');
      meta.appendChild(el('span', null, cp)); meta.appendChild(el('span', null, r.startedAt ? dur(r.startedAt) + ' elapsed' : '')); box.appendChild(meta);
      if (r.activity) box.appendChild(el('div', 'wmeta ko', r.activity));
      ws.appendChild(box);
    });

    var rows = $('rows'); clear(rows);
    var shown = st.stages.filter(visible);
    if (!shown.length) rows.appendChild(el('div', 'empty', filter === 'focus' ? 'nothing running or ready right now' : 'no matching stages'));
    shown.forEach(function(r){
      var k = kind(r);
      var row = el('div', 'row ' + (k === 'stale' ? 'human' : k));
      row.appendChild(el('span', 'id', r.id));
      row.appendChild(el('span', 'nm', r.name));
      row.appendChild(el('span', 'tag', r.status === 'IN_PROGRESS' ? (r.phaseLabel || 'run') : (r.model || '') + ' ' + (r.size || '')));
      var bc = el('div', 'barc'); bc.appendChild(bar(r.status === 'TODO' ? 0 : r.percent, COLOR[k], k === 'run')); row.appendChild(bc);
      row.appendChild(el('span', 'pct', r.status === 'TODO' ? '' : r.percent + '%'));
      row.appendChild(chip(r));
      row.appendChild(detail(r));
      rows.appendChild(row);
    });

    var ev = $('events'); clear(ev);
    $('evCount').textContent = st.events.length ? 'last ' + Math.min(st.events.length, 30) : '';
    if (!st.events.length) ev.appendChild(el('div', 'empty', 'no events yet — they appear once a stage starts'));
    st.events.slice(0, 30).forEach(function(e){
      var cls = 'ev' + (e.kind === 'finish' ? (/BLOCKED/.test(e.text) ? ' blk' : ' fin') : (e.kind === 'note' || e.kind === 'phase' ? ' minor' : ''));
      var d = el('div', cls);
      d.appendChild(el('span', 't', hhmm(e.t)));
      d.appendChild(el('span', 's' + (e.stage ? '' : ' orc'), e.stage || 'orc'));
      d.appendChild(el('span', 'a', '›'));
      d.appendChild(el('span', 'x ko', e.text));
      ev.appendChild(d);
    });

    var td = $('todos'); clear(td);
    $('todoCount').textContent = st.todos.openCount ? st.todos.openCount + ' open' : '';
    if (!st.todos.open.length) td.appendChild(el('li', 'empty', '지금은 없어요'));
    st.todos.open.forEach(function(t){ td.appendChild(el('li', null, t)); });

    var cm = $('commits'); clear(cm);
    if (!st.commits.length) cm.appendChild(el('div', 'empty', 'no git history found'));
    st.commits.forEach(function(k){ var d = el('div', 'commit'); d.appendChild(el('code', null, k.hash)); d.appendChild(el('span', null, k.subject)); d.appendChild(el('span', 'when', ago(k.t))); cm.appendChild(d); });
  }

  function tick(){
    fetch('/api/state' + location.search, { cache: 'no-store' })
      .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function(st){ last = st; render(st); })
      .catch(function(){
        $('pulse').className = 'pulse off'; $('clock').textContent = 'OFFLINE';
        $('warn').textContent = '⚠ 보드 서버와 연결이 끊겼습니다. 보드를 실행한 창이 열려 있는지 확인하세요.'; $('warn').className = 'warn ko on';
      });
  }
  function syncTabs(){ Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function(x){ x.setAttribute('aria-pressed', String(x.getAttribute('data-f') === filter)); }); }
  Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function(b){
    b.addEventListener('click', function(){ filter = b.getAttribute('data-f'); try { localStorage.setItem('board.filter', filter); } catch (e) {} syncTabs(); if (last) render(last); });
  });
  syncTabs();
  $('theme').addEventListener('click', function(){
    var next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('board.theme', next); } catch (e) {}
  });
  tick();
  setInterval(tick, POLL);
})();
</script>
</body>
</html>`;

// ───────────────────────── 시작 ─────────────────────────
if (has('--json')) process.stdout.write(JSON.stringify(buildState(), null, 2) + '\n');
else if (has('--web')) runWeb();
else runTerminal();

#!/usr/bin/env node
// 진행 상황 보드 (의존성 없음, Node 18+). 읽기만 하고 어떤 파일도 고치지 않는다.
//
//   node scripts/board.mjs                 터미널 보드 (2초마다 갱신, q 또는 Ctrl+C로 종료)
//   node scripts/board.mjs --web           웹 보드 http://127.0.0.1:4545 (이 컴퓨터에서만 열림)
//   node scripts/board.mjs --web --open    웹 보드를 띄우고 브라우저도 연다
//   node scripts/board.mjs --web --lan     같은 와이파이의 휴대폰에서도 열 수 있게 (비밀 주소가 출력됨)
//   node scripts/board.mjs --agents        터미널 에이전트 화면: orc ↔ 차수·검토 서브에이전트와 메시지 (보드에서 a 키로 전환)
//   node scripts/board.mjs --once          한 번만 출력하고 끝 (/status 명령, 로그용)
//   node scripts/board.mjs --json          상태를 JSON으로 출력
// 옵션: --port 4545  --interval 2  --ascii (막대·표시가 깨져 보이면)  --no-color  --rows 40 --cols 100 (--once 크기)
//
// 읽는 것: prompts/STAGES.md(차수 목록·의존), PROGRESS.md(공식 상태), .runner/board/*.json(실시간 진행률),
//          .runner/events.jsonl(활동 기록), .runner/STATUS, HUMAN_TODO.md, git log,
//          .runner/usage.json(Claude 사용량: scripts/statusline.mjs가 Claude Code 상태줄에서 기록)
// 웹 보드의 agents 패널: orchestrator(지휘자) ↔ 차수 서브에이전트 ↔ 검토 서브에이전트 사이의 메시지를 활동 기록에서 재구성한다
//          (status.mjs msg로 남긴 메시지는 그대로, 나머지는 start·checkpoint·phase·finish 기록에서 추정)

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
        if (e && e.t) out.push({ t: e.t, stage: e.stage ?? null, kind: String(e.kind ?? ''), text: String(e.text ?? ''), worker: e.worker ?? null, from: e.from ?? null, to: e.to ?? null });
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

// ───────────────────────── 에이전트 채널 ─────────────────────────
// orc(지휘자) ↔ 차수 서브에이전트(SNN) ↔ 그 차수의 검토 서브에이전트(SNN:review) 사이에 오간 것을 활동 기록에서 다시 만든다.
// 명시적 메시지(status.mjs msg)는 그대로 쓰고, 나머지는 기록 종류로 추정한다(inferred=true).
function agentId(role, stage) {
  if (role === 'orc' || role === 'conductor' || role === 'runner') return 'orc';
  if (/^S\d{2}(:review)?$/.test(role)) return role;
  if (!stage) return null;
  if (role === 'builder' || role === 'stage') return stage;
  if (role === 'reviewer' || role === 'review') return `${stage}:review`;
  return null;
}

function agentMessages(events) {
  const out = [];
  const phaseOf = {};
  const push = (e, stage, from, to, text, inferred = true) => {
    const f = agentId(from, stage);
    const t = agentId(to, stage);
    if (!f || !t || f === t) return;
    out.push({ t: e.t, stage: stage ?? null, from: f, to: t, text, inferred });
  };
  for (const e of events) {
    const st = e.stage;
    const prev = st ? phaseOf[st] : null;
    switch (e.kind) {
      case 'msg':
        push(e, st, e.from, e.to, e.text, false);
        break;
      case 'runner': {
        if (/^stop/i.test(e.text)) break;
        const m = e.text.match(/^(S\d{2})\b/);
        if (m) push(e, m[1], 'orc', 'builder', /retry/i.test(e.text) ? `재시도 지시 · ${e.text}` : `${m[1]} 맡김`);
        break;
      }
      case 'start':
        push(e, st, 'builder', 'orc', '수락 · 시작');
        break;
      case 'resume':
        push(e, st, 'builder', 'orc', '이어서 시작');
        break;
      case 'plan':
        push(e, st, 'builder', 'orc', `계획 보고 · ${e.text.replace(/^plan ready · /, '')}`);
        break;
      case 'checkpoint':
        push(e, st, 'builder', 'orc', e.text);
        break;
      case 'phase': {
        const ph = (e.text.match(/phase → (\w+)/) || [])[1] || '';
        if (ph === 'review') push(e, st, 'builder', 'reviewer', '적대적 검토 요청');
        else if (prev === 'review') push(e, st, 'reviewer', 'builder', ph === 'build' ? '검토 지적 전달 · 수정 필요' : '검토 결과 전달');
        if (st) phaseOf[st] = ph;
        break;
      }
      case 'finish':
        if (st && phaseOf[st] === 'review') push(e, st, 'reviewer', 'builder', '검토 결과 전달');
        push(e, st, 'builder', 'orc', `결과 보고 · ${e.text}`);
        if (st) phaseOf[st] = null;
        break;
      default:
        break;
    }
  }
  return out;
}

// ───────────────────────── 에이전트가 지금 하는 일 ─────────────────────────
// Claude Code 대화 기록(~/.claude/projects/<저장소>/<세션>.jsonl, <세션>/subagents/agent-*.jsonl)의 끝부분에서
// 마지막 도구 호출만 읽어 'Bash(설명)', 'Edit(파일)'처럼 보여 준다. 명령 본문·파일 내용은 보여 주지 않는다.
const LIVE_MS = 10 * 60_000; // 이 시간 안에 기록이 바뀐 에이전트만 '지금 하는 일'을 보여 준다
const liveCache = new Map();

function claudeProjectDir() {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, 'projects', ROOT.replace(/[^a-zA-Z0-9]/g, '-'));
}

function shortPath(p) {
  const s = String(p || '');
  const rel = path.relative(ROOT, s);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return path.basename(s);
  const parts = rel.split(path.sep);
  return parts.length > 2 && rel.length > 28 ? '…/' + parts.slice(-2).join('/') : parts.join('/'); // 좁은 상자에서도 파일 이름이 보이게
}

function describeTool(name, input = {}) {
  const cut = (x, n = 60) => {
    const t = String(x ?? '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  };
  let arg = '';
  if (name === 'Bash' || name === 'PowerShell') arg = input.description ? cut(input.description) : cut(String(input.command || '').split(/\s+/)[0], 20);
  else if (['Read', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit'].includes(name)) arg = shortPath(input.file_path || input.notebook_path);
  else if (name === 'Grep' || name === 'Glob') arg = cut(input.pattern, 40);
  else if (name === 'Agent' || name === 'Task') arg = cut(input.description, 50);
  else if (name === 'Skill') arg = cut(input.skill, 30);
  else if (name === 'WebSearch') arg = cut(input.query, 40);
  else if (name === 'WebFetch') {
    try {
      arg = new URL(input.url).host;
    } catch {
      arg = '';
    }
  }
  return arg ? `${name}(${arg})` : name;
}

function readLiveTranscript(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const hit = liveCache.get(file);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.v;
  let v = null;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const len = Math.min(st.size, 512 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    const lines = buf.toString('utf8').split('\n');
    if (len < st.size) lines.shift();
    let lastTool = null;
    let lastKind = null;
    let lastT = null;
    const done = new Set();
    for (const l of lines) {
      if (!l.trim()) continue;
      let e;
      try {
        e = JSON.parse(l);
      } catch {
        continue;
      }
      const content = Array.isArray(e?.message?.content) ? e.message.content : [];
      if (e.type === 'assistant') {
        for (const c of content) {
          if (c.type === 'tool_use') {
            lastTool = { id: c.id, label: describeTool(c.name, c.input), t: e.timestamp };
            lastKind = 'tool';
          } else if (c.type === 'text' && c.text && c.text.trim()) lastKind = 'text';
          else if (c.type === 'thinking') lastKind = lastKind === 'tool' ? 'tool' : 'thinking';
        }
        lastT = e.timestamp || lastT;
      } else if (e.type === 'user') {
        for (const c of content) if (c.type === 'tool_result') done.add(c.tool_use_id);
        lastT = e.timestamp || lastT;
        if (content.some((c) => c.type === 'tool_result')) lastKind = 'thinking';
      }
    }
    if (lastTool && !done.has(lastTool.id)) v = { kind: 'tool', label: lastTool.label, since: lastTool.t, at: st.mtimeMs };
    else if (lastKind === 'text') v = { kind: 'text', label: '응답 작성', since: lastT, at: st.mtimeMs };
    else v = { kind: 'thinking', label: lastTool ? lastTool.label : '생각 중', since: lastT, at: st.mtimeMs };
  } catch {
    v = null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  liveCache.set(file, { mtime: st.mtimeMs, size: st.size, v });
  return v;
}

function loadLiveAgents(now) {
  const out = { orc: null, stages: {}, reviewers: {} };
  const dir = claudeProjectDir();
  let sessions = [];
  try {
    sessions = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .slice(0, 2);
  } catch {
    return out;
  }
  if (sessions[0] && now - sessions[0].m < LIVE_MS) out.orc = readLiveTranscript(path.join(dir, sessions[0].f));
  for (const s of sessions) {
    const sd = path.join(dir, s.f.replace(/\.jsonl$/, ''), 'subagents');
    let files = [];
    try {
      files = fs.readdirSync(sd).filter((f) => /^agent-[\w-]+\.meta\.json$/.test(f));
    } catch {
      continue;
    }
    const metas = {};
    for (const f of files) {
      try {
        metas[f.slice(6, -10)] = JSON.parse(fs.readFileSync(path.join(sd, f), 'utf8'));
      } catch {
        /* 쓰는 중 */
      }
    }
    const stageOf = (id, depth = 0) => {
      const m = metas[id];
      if (!m || depth > 3) return null;
      const hit = String(m.description || '').match(/\bS(\d{2})\b/);
      if (hit) return 'S' + hit[1];
      return m.parentAgentId ? stageOf(m.parentAgentId, depth + 1) : null;
    };
    for (const [id, m] of Object.entries(metas)) {
      const stage = stageOf(id);
      if (!stage) continue;
      const v = readLiveTranscript(path.join(sd, `agent-${id}.jsonl`));
      if (!v || now - v.at > LIVE_MS) continue;
      const bucket = m.agentType === 'adversarial-reviewer' || /review/i.test(m.agentType || '') ? out.reviewers : out.stages;
      if (!bucket[stage] || bucket[stage].at < v.at) bucket[stage] = v;
    }
  }
  return out;
}

function buildAgents(rows, events, runnerState) {
  const msgs = agentMessages(events);
  const live = loadLiveAgents(Date.now());
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  // 보여 줄 차수: 진행 중인 차수 + 최근에 활동한 차수, 최대 3개(오래된 것이 왼쪽)
  const recent = [];
  for (let i = events.length - 1; i >= 0 && recent.length < 3; i--) {
    const id = events[i].stage || (events[i].kind === 'runner' ? (events[i].text.match(/^(S\d{2})\b/) || [])[1] : null);
    if (id && byId[id] && !recent.includes(id)) recent.push(id);
  }
  for (const r of rows) if (r.status === 'IN_PROGRESS' && !recent.includes(r.id)) recent.unshift(r.id);
  const reviewed = new Set(msgs.filter((m) => m.to.endsWith(':review')).map((m) => m.stage));
  const stages = recent.slice(0, 3).reverse().map((id) => {
    const r = byId[id];
    let state;
    let text;
    if (r.status === 'IN_PROGRESS') {
      state = r.stale ? 'alert' : r.phase === 'review' ? 'wait' : 'active';
      text = r.stale ? '응답 없음 · /resume 필요' : r.phase === 'review' ? '검토 결과 대기' : r.activity || r.phaseLabel || '';
    } else if (r.status === 'BLOCKED') {
      state = 'blocked';
      text = r.summary || '막힘';
    } else if (r.status === 'TODO') {
      state = 'wait';
      text = '대기';
    } else {
      state = 'done';
      text = r.summary || r.status;
    }
    let reviewer = null;
    const lr = live.reviewers[id];
    if (lr && r.status === 'IN_PROGRESS') reviewer = { state: 'active', text: '적대적 검토 중', now: lr };
    else if (r.status === 'IN_PROGRESS' && r.phase === 'review') reviewer = { state: r.stale ? 'alert' : 'active', text: r.activity || '적대적 검토 중' };
    else if (reviewed.has(id)) reviewer = { state: 'done', text: '검토 끝' };
    const ls = r.status === 'IN_PROGRESS' ? live.stages[id] : null;
    if (ls && state === 'alert') {
      state = 'active'; // 기록은 조용해도 대화 기록이 움직이면 일하는 중이다
      text = r.activity || r.phaseLabel || '';
    }
    if (lr && r.status === 'IN_PROGRESS' && state === 'active' && !ls) state = 'wait';
    return { id, name: r.name, state, text, reviewer, now: ls || null, pct: r.percent, startedAt: r.startedAt, finishedAt: r.finishedAt, status: r.status };
  });
  const run = rows.find((r) => r.status === 'IN_PROGRESS') || null;
  let orc;
  if (run) orc = run.stale ? { state: 'alert', text: `${run.id} 응답 없음` } : { state: 'wait', text: `${run.id} 결과 대기` };
  else if (runnerState === 'stopped') orc = { state: 'blocked', text: '러너 멈춤' };
  else if (runnerState === 'finished') orc = { state: 'done', text: '모든 차수 완료' };
  else orc = { state: 'standby', text: '다음 차수 고르는 중' };
  orc.now = live.orc;
  if (live.orc && live.orc.kind === 'tool' && orc.state !== 'alert') orc.state = 'active';
  const done = rows.filter((r) => r.status === 'DONE' || r.status === 'DONE_NEEDS_HUMAN').length;
  return { orc, stages, messages: msgs.slice(-40).reverse(), summary: { done, total: rows.length, run: run ? { id: run.id, pct: run.percent } : null } };
}

// Claude 사용 한도(5시간 세션·주간). scripts/statusline.mjs가 Claude Code 상태줄 입력에서 받아 적어 둔 값이다.
function loadUsage() {
  try {
    const u = JSON.parse(readText(P('.runner', 'usage.json')));
    if (!u || !u.at) return null;
    const ok = (w) => (w && Number.isFinite(w.usedPct) ? { usedPct: w.usedPct, resetsAt: w.resetsAt ?? null } : null);
    return { at: u.at, fiveHour: ok(u.fiveHour), sevenDay: ok(u.sevenDay), model: u.model ?? null };
  } catch {
    return null;
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
  const agentEvents = loadEvents(400);
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
    usage: loadUsage(),
    agents: buildAgents(rows, agentEvents, runner.state),
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
  const nowTxt = `${hhmm(st.now)} · a agents · q quit`;
  L.push(` ${bold(cyan('BINJARI'))} ${gray('// mission control · ' + st.project)}` + ' '.repeat(Math.max(1, cols - 4 - width('BINJARI // mission control · ' + st.project) - width(nowTxt))) + gray(nowTxt));
  if (!st.hasStages) {
    L.push(red(' prompts/STAGES.md를 찾지 못했습니다. 저장소 맨 위 폴더에서 실행하세요.'));
    return L.join('\n');
  }
  const c = st.counts;
  L.push(` overall ${bar(st.overall, 24, green)} ${bold(st.overall + '%')}  ${green('done ' + (c.DONE + c.DONE_NEEDS_HUMAN) + '/' + st.total)}${c.DONE_NEEDS_HUMAN ? yellow(` (확인필요 ${c.DONE_NEEDS_HUMAN})`) : ''} · ${cyan('running ' + c.IN_PROGRESS)} · ${c.BLOCKED ? red('blocked ' + c.BLOCKED) : 'blocked 0'} · left ${c.TODO}`);
  const rc = st.runner.state === 'working' ? cyan : st.runner.state === 'stalled' ? yellow : st.runner.state === 'finished' ? green : gray;
  L.push(` orchestrator ${rc((ASCII ? '* ' : '● ') + st.runner.label)}${st.runner.lastActivity ? gray(' · last activity ' + agoEn(st.runner.lastActivity)) : ''}`);
  const ub = usageBits(st.usage, { bars: true });
  L.push(' claude       ' + (ub.length ? ub.join(gray('  ·  ')) : gray('사용량 정보 없음 — Claude Code 상태줄이 아직 기록하지 않았어요 (scripts/statusline.mjs)')));
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

// 사용 한도 한 조각: '5시간 77% 남음 ↻2h10m'
function untilShort(iso) {
  if (!iso) return '';
  const ms = Date.parse(iso) - Date.now();
  if (!(ms > 0)) return '곧';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h${pad2(m % 60)}m` : `${Math.floor(h / 24)}d${h % 24}h`;
}
function usageBits(u, { bars = false } = {}) {
  if (!u) return [];
  const out = [];
  for (const [label, w] of [['5시간', u.fiveHour], ['주간', u.sevenDay]]) {
    if (!w) continue;
    const left = 100 - w.usedPct;
    const tone = w.usedPct >= 85 ? red : w.usedPct >= 60 ? yellow : green;
    const b = bars ? ' ' + bar(left, 10, tone) : '';
    out.push(`${gray(label)}${b} ${tone(`${left}% 남음`)}${w.resetsAt ? gray(` ↻${untilShort(w.resetsAt)}`) : ''}`);
  }
  const age = Date.now() - Date.parse(u.at);
  if (out.length && age > 15 * 60_000) out.push(gray(`(${hhmm(u.at)} 기준)`));
  return out;
}

// ───────────────────────── 터미널 에이전트 화면 ─────────────────────────
// orc 아래에 최근 차수 서브에이전트, 그 아래에 검토 서브에이전트를 상자로 그리고, 새 메시지는 연결선을 따라 ● 로 날아간다.
const rgb = (r, g, b) => (s) => (COLOR ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m` : String(s));
const AGC = { orc: rgb(217, 119, 87), stage: rgb(177, 185, 249), review: rgb(229, 143, 176) };
const agKind = (id) => (id === 'orc' ? 'orc' : id.endsWith(':review') ? 'review' : 'stage');
const agLabel = (id) => (id === 'orc' ? 'orchestrator' : id.endsWith(':review') ? `${id.slice(0, 3)} reviewer` : `${id} subagent`);
const AG_SPIN = ASCII ? ['-', '\\', '|', '/'] : ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
const AG_VERB = { wait: 'Waiting…', standby: 'Idle ·', alert: 'No response ·', blocked: 'Blocked ·', done: 'Done ·' };
const AG_ACTIVE = { orc: 'Orchestrating…', stage: 'Building…', review: 'Reviewing…' };
const agoShort = (ms) => (ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 3_600_000)}h`);
const PKT_MS = 2600; // 메시지 하나가 선을 따라 이동하는 시간
const FLASH_MS = 1800; // 받은 쪽이 'Received'로 빛나는 시간
const HEAVY = { '│': '┃', '─': '━', '┌': '┏', '┐': '┓', '└': '┗', '┘': '┛', '├': '┣', '┤': '┫', '┬': '┳', '┴': '┻', '┼': '╋' };
const DOTTED = { '│': '┆', '─': '┄' };
// 연결선 방향 비트: 위 1, 아래 2, 왼쪽 4, 오른쪽 8
const BOXCH = ASCII
  ? { 3: '|', 1: '|', 2: '|', 12: '-', 4: '-', 8: '-', default: '+' }
  : { 3: '│', 1: '│', 2: '│', 12: '─', 4: '─', 8: '─', 10: '┌', 6: '┐', 9: '└', 5: '┘', 11: '├', 7: '┤', 14: '┬', 13: '┴', 15: '┼' };

class Canvas {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.cells = Array.from({ length: h }, () => Array.from({ length: w }, () => ({ ch: ' ', col: null })));
    this.masks = new Map();
  }
  put(x, y, ch, col) {
    if (y < 0 || y >= this.h || x < 0 || x >= this.w) return;
    this.cells[y][x] = { ch, col };
  }
  text(x, y, str, col, maxW) {
    let cx = x;
    const end = x + (maxW ?? this.w - x);
    for (const ch of String(str)) {
      const cw = charWidth(ch.codePointAt(0));
      if (cw === 0) continue;
      if (cx + cw > end) break;
      this.put(cx, y, ch, col);
      if (cw === 2) this.put(cx + 1, y, '', col);
      cx += cw;
    }
    return cx;
  }
  link(x, y, bits, hot) {
    const k = y * this.w + x;
    const m = this.masks.get(k) || { x, y, bits: 0, hot: false };
    m.bits |= bits;
    m.hot = m.hot || hot;
    this.masks.set(k, m);
  }
  flushLinks() {
    for (const m of this.masks.values()) this.put(m.x, m.y, BOXCH[m.bits] ?? BOXCH.default ?? '+', m.hot ? AGC.orc : gray);
  }
  lines() {
    return this.cells.map((row) => {
      let out = '';
      let run = '';
      let col = undefined;
      for (const c of row) {
        if (c.col !== col) {
          out += col ? col(run) : run;
          run = '';
          col = c.col;
        }
        run += c.ch;
      }
      out += col ? col(run) : run;
      return out.replace(/\s+$/, '');
    });
  }
}

function agBox(cv, x, y, w, h, border) {
  const [tl, tr, bl, br, hz, vt] = ASCII ? ['+', '+', '+', '+', '-', '|'] : ['╭', '╮', '╰', '╯', '─', '│'];
  cv.text(x, y, tl + hz.repeat(w - 2) + tr, border);
  for (let i = 1; i < h - 1; i++) {
    cv.put(x, y + i, vt, border);
    cv.put(x + w - 1, y + i, vt, border);
  }
  cv.text(x, y + h - 1, bl + hz.repeat(w - 2) + br, border);
}

function agUnit(cv, id, u, x, y, w, sub, view) {
  const kind = agKind(id);
  const kc = AGC[kind];
  const flashing = view.flash && view.flash.id === id && view.now < view.flash.until;
  const border = flashing ? (t) => bold(kc(t)) : u.state === 'active' ? kc : u.state === 'alert' ? yellow : u.state === 'blocked' ? red : gray;
  const h = sub ? 6 : 5;
  agBox(cv, x, y, w, h, border);
  // 맨 아래 줄: 지금 실행 중인 도구 호출(대화 기록에서)
  if (u.now) {
    const age = u.now.since ? agoShort(view.now - Date.parse(u.now.since)) : '';
    const mark = u.now.kind === 'tool' ? (ASCII ? '> ' : '▸ ') : u.now.kind === 'text' ? (ASCII ? '~ ' : '✎ ') : ASCII ? '. ' : '… ';
    let nx = cv.text(x + 2, y + h - 2, ASCII ? 'L ' : '⎿ ', gray);
    nx = cv.text(nx, y + h - 2, mark, u.now.kind === 'tool' ? AGC.orc : gray);
    const tail = age ? ` · ${age}` : '';
    const ex = cv.text(nx, y + h - 2, u.now.label, u.now.kind === 'tool' ? (t) => bold(t) : gray, x + w - 2 - nx - width(tail));
    if (tail) cv.text(ex, y + h - 2, tail, gray);
  } else if (u.state === 'done' && u.startedAt && u.finishedAt) {
    cv.text(x + 2, y + h - 2, `${ASCII ? 'L v' : '⎿ ✓'} ${dur(u.startedAt, u.finishedAt)} 걸림`, gray);
  } else cv.text(x + 2, y + h - 2, u.state === 'done' ? (ASCII ? 'L v' : '⎿ ✓') : ASCII ? 'L -' : '⎿ —', gray);
  // 진행 중인 차수: 아래 테두리가 진행률 막대
  if (u.pct != null && u.status === 'IN_PROGRESS') {
    const inner = w - 2;
    const fill = Math.round((inner * Math.max(0, Math.min(100, u.pct))) / 100);
    for (let i = 0; i < fill; i++) cv.put(x + 1 + i, y + h - 1, ASCII ? '=' : '━', kc);
    const tag = ` ${u.pct}% `;
    if (inner > width(tag) + 4) cv.text(x + w - 2 - width(tag), y + h - 1, tag, (t) => bold(kc(t)));
  }
  const glyph = u.state === 'active' ? AG_SPIN[view.spin % AG_SPIN.length] : u.state === 'done' ? (ASCII ? 'v' : '✓') : u.state === 'alert' || u.state === 'blocked' ? '!' : 'o';
  const glyphCol = u.state === 'done' ? green : u.state === 'alert' ? yellow : u.state === 'blocked' ? red : kc;
  cv.text(x + 2, y + 1, glyph, glyphCol);
  const label = agLabel(id);
  const elapsed = u.state === 'active' && u.startedAt ? ` · ${dur(u.startedAt)}` : '';
  const want = u.state + elapsed;
  const right = width(label) + width(want) + 7 <= w ? want : width(label) + width(u.state) + 7 <= w ? u.state : ''; // 좁으면 이름을 살린다
  cv.text(x + 4, y + 1, label, u.state === 'done' ? dim : (t) => bold(kc(t)), w - 6);
  if (right) cv.text(x + w - 2 - width(right), y + 1, right, gray);
  let row = y + 2;
  if (sub) cv.text(x + 2, row++, fit(sub, w - 4), gray, w - 4);
  const sending = view.anim && view.anim.m.from === id && view.now - view.anim.start < PKT_MS;
  const received = flashing && view.flash.m;
  if (sending || received) {
    const m = sending ? view.anim.m : view.flash.m;
    const vx = cv.text(x + 2, row, sending ? `Sending → ${agLabel(m.to)}` : `Received ${ASCII ? 'v' : '✓'}`, (t) => bold(AGC.orc(t)), w - 4);
    cv.text(vx + 1, row, m.text, null, x + w - 2 - (vx + 1));
    return h;
  }
  const verb = u.state === 'active' ? AG_ACTIVE[kind] : AG_VERB[u.state] || u.state;
  const vx = cv.text(x + 2, row, verb, u.state === 'done' ? dim : kc, w - 4);
  if (u.text) cv.text(vx + 1, row, u.text, u.state === 'done' ? gray : null, x + w - 2 - (vx + 1));
  return h;
}

// 부모 상자 아래(ay)에서 자식 상자 위(by)까지: 내려가고, midY에서 옆으로, 다시 내려간다
function agPath(ax, ay, bx, by, midY) {
  const pts = [];
  for (let y = ay; y <= midY; y++) pts.push([ax, y]);
  const step = bx > ax ? 1 : -1;
  for (let x = ax + step; bx !== ax && x !== bx + step; x += step) pts.push([x, midY]);
  for (let y = midY + 1; y <= by; y++) pts.push([bx, y]);
  return pts;
}

function agDrawPath(cv, pts, hot) {
  pts.forEach(([x, y], i) => {
    let bits = 0;
    const nb = [pts[i - 1], pts[i + 1]];
    if (i === 0) bits |= 1;
    if (i === pts.length - 1) bits |= 2;
    for (const q of nb) {
      if (!q) continue;
      if (q[1] < y) bits |= 1;
      else if (q[1] > y) bits |= 2;
      else if (q[0] < x) bits |= 4;
      else if (q[0] > x) bits |= 8;
    }
    cv.link(x, y, bits, hot);
  });
}

function renderAgents(st, cols, rows, view) {
  const W = Math.max(60, Math.min(cols || 100, 160));
  const H = Math.max(20, rows || 40);
  const ag = st.agents;
  const now = view.now;
  const head = ` ${AGC.orc((ASCII ? '* ' : '✻ ') + 'binjari')} ${bold('agents')} ${gray('· orchestrator ↔ subagents')}`;
  const ub = usageBits(st.usage);
  const right = (ub.length ? ub.join(gray(' · ')) + gray('   ') : '') + gray(`${hhmm(st.now)} · a board · q quit`);
  const L = [head + ' '.repeat(Math.max(1, W - width(head) - width(right) - 1)) + right];
  if (!ag) return L.join('\n');

  const n = ag.stages.length;
  const hasReview = ag.stages.some((x) => x.reviewer);
  const gap = 2;
  const cardW = n ? Math.min(46, Math.floor((W - 2 - gap * (n - 1)) / n)) : 0;
  const x0 = Math.floor((W - (n * cardW + gap * (n - 1))) / 2);
  const ow = Math.min(46, W - 4);
  // 차수가 홀수 개면 orc 중심을 가운데 상자 중심에 맞춰 연결선이 곧게 내려가게 한다
  const oc = n % 2 ? x0 + ((n - 1) / 2) * (cardW + gap) + Math.floor(cardW / 2) : Math.floor(W / 2);
  const ox = Math.max(0, Math.min(W - ow, oc - Math.floor(ow / 2)));
  const oy = 1;
  const sy = oy + 6 + 2; // orchestrator 상자 6줄 + 연결선 2줄
  const ry = sy + 6 + 1; // 차수 상자 6줄 + 연결선 1줄
  const ch = hasReview ? ry + 6 : n ? sy + 6 : oy + 6;
  const cv = new Canvas(W, ch);

  const hotPair = (a, b) => ag.messages.some((m) => ((m.from === a && m.to === b) || (m.from === b && m.to === a)) && now - Date.parse(m.t) < 15 * 60_000);
  const paths = {};
  ag.stages.forEach((sx, i) => {
    const x = x0 + i * (cardW + gap);
    const c = x + Math.floor(cardW / 2);
    sx._x = x;
    sx._c = c;
    const p1 = agPath(oc, oy + 6, c, sy - 1, oy + 6);
    paths[`orc>${sx.id}`] = p1;
    agDrawPath(cv, p1, hotPair('orc', sx.id));
    if (sx.reviewer) {
      const p2 = agPath(c, sy + 6, c, ry - 1, sy + 6);
      paths[`${sx.id}>${sx.id}:review`] = p2;
      agDrawPath(cv, p2, hotPair(sx.id, `${sx.id}:review`));
    }
  });
  cv.flushLinks();

  agUnit(cv, 'orc', ag.orc, ox, oy, ow, '지휘자 · 차수를 맡기고 결과를 확인', view);
  for (const sx of ag.stages) {
    agUnit(cv, sx.id, sx, sx._x, sy, cardW, sx.name, view);
    if (sx.reviewer) agUnit(cv, `${sx.id}:review`, sx.reviewer, sx._x, ry, cardW, 'adversarial-reviewer', view);
  }
  // 상자 테두리와 연결선이 만나는 곳
  const joint = (x, y, up) => {
    const hotAny = [...cv.masks.values()].some((m) => m.x === x && (m.y === y + 1 || m.y === y - 1) && m.hot);
    cv.put(x, y, ASCII ? '+' : up ? '┴' : '┬', hotAny ? AGC.orc : gray);
  };
  if (n) joint(oc, oy + 5, false);
  for (const sx of ag.stages) {
    joint(sx._c, sy, true);
    if (sx.reviewer) {
      joint(sx._c, sy + 5, false);
      joint(sx._c, ry, true);
    }
  }
  // 전송 중인 메시지: 지나온 길은 굵은 선, 남은 길은 점선, 그 사이를 ● 가 움직인다
  const a = view.anim;
  if (a && now - a.start < PKT_MS) {
    const k = (now - a.start) / PKT_MS;
    const child = a.m.from === 'orc' ? a.m.to : a.m.to === 'orc' ? a.m.from : a.m.from.endsWith(':review') ? a.m.from : a.m.to;
    const parent = child.endsWith(':review') ? child.slice(0, 3) : 'orc';
    let pts = paths[`${parent}>${child}`];
    const pc = AGC[agKind(a.m.from)];
    if (pts) {
      if (a.m.from === child) pts = [...pts].reverse();
      const idx = Math.min(pts.length - 1, Math.floor(k * pts.length));
      pts.forEach(([px, py], j) => {
        const cur = cv.cells[py]?.[px]?.ch ?? ' ';
        if (j < idx) cv.put(px, py, ASCII ? '#' : HEAVY[cur] ?? cur, (t) => bold(pc(t)));
        else if (j > idx) cv.put(px, py, ASCII ? ':' : DOTTED[cur] ?? cur, pc);
      });
      const [px, py] = pts[idx];
      cv.put(px, py, ASCII ? '@' : '●', (t) => bold(pc(t)));
    }
    // 맨 윗줄: 전송 표시줄
    const track = 18;
    const pos = Math.min(track - 1, Math.floor(k * track));
    let bar = '';
    for (let j = 0; j < track; j++) bar += j < pos ? (ASCII ? '=' : '━') : j === pos ? (ASCII ? '@' : '●') : ASCII ? '.' : '┄';
    let bx = cv.text(1, 0, ASCII ? '>> ' : '⇢ ', (t) => bold(AGC.orc(t)));
    bx = cv.text(bx, 0, agLabel(a.m.from), (t) => bold(pc(t)));
    bx = cv.text(bx + 1, 0, bar, pc);
    bx = cv.text(bx + 1, 0, agLabel(a.m.to), (t) => bold(AGC[agKind(a.m.to)](t)));
    cv.text(bx + 2, 0, `"${a.m.text}"`, null, W - bx - 4);
  }
  if (!(a && now - a.start < PKT_MS) && ag.summary) {
    const sm = ag.summary;
    const pct = sm.total ? Math.round((100 * sm.done) / sm.total) : 0;
    let bx = cv.text(1, 0, ASCII ? '* ' : '✻ ', AGC.orc);
    bx = cv.text(bx, 0, `done ${sm.done}/${sm.total} `, gray);
    const track = 14;
    const f = Math.round((track * pct) / 100);
    bx = cv.text(bx, 0, (ASCII ? '=' : '━').repeat(f), green);
    bx = cv.text(bx, 0, (ASCII ? '.' : '┄').repeat(track - f), gray);
    if (sm.run) cv.text(bx + 2, 0, `${sm.run.id} ${sm.run.pct}% 진행 중`, AGC.stage);
  }
  if (!n) cv.text(2, oy + 7, 'no subagents yet', gray);
  L.push(...cv.lines());

  L.push(gray((ASCII ? '-' : '─').repeat(W)));
  const room = H - L.length;
  const newest = view.anim ? view.anim.m : null;
  for (const m of ag.messages) {
    if (L.length + 2 > H) break;
    const kc = AGC[agKind(m.from)];
    const isNew = newest && m.t === newest.t && m.from === newest.from && m.to === newest.to;
    const t = hhmm(m.t);
    const left = ` ${kc(ASCII ? '*' : '⏺')} ${bold(kc(agLabel(m.from)))} ${gray('→')} ${agLabel(m.to)}${m.inferred ? '' : gray(' · msg')}`;
    L.push(left + ' '.repeat(Math.max(1, W - width(left) - width(t) - 1)) + gray(t));
    const body = fit(m.text, W - 7);
    L.push(`   ${gray(ASCII ? 'L' : '⎿')}  ${isNew ? bold(body) : body}`);
  }
  if (!ag.messages.length && room > 1) L.push(gray('  no messages yet'));
  return L.slice(0, H).map((l) => l.replace(/\s+$/, '')).join('\n');
}

function runTerminal() {
  const interval = Math.max(1, Number(opt('--interval', 2))) * 1000;
  let mode = has('--agents') ? 'agents' : 'board';
  const view = { spin: 0, now: Date.now(), anim: null, flash: null };
  if (has('--once') || !process.stdout.isTTY) {
    const cols = Number(opt('--cols', process.stdout.columns || 110));
    const rows = Number(opt('--rows', 60));
    const st = buildState();
    process.stdout.write((mode === 'agents' ? renderAgents(st, cols, rows, view) : renderTerminal(st, cols, rows)) + '\n');
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
  let st = null;
  let seenT = null;
  const queue = [];
  function refresh() {
    try {
      st = buildState();
    } catch (e) {
      st = { error: String(e?.message ?? e) };
      return;
    }
    const msgs = st.agents?.messages ?? [];
    if (seenT === null) {
      if (msgs[0]) queue.push(msgs[0]);
    } else {
      for (const m of [...msgs].reverse()) if (Date.parse(m.t) > seenT) queue.push(m);
    }
    if (msgs[0]) seenT = Math.max(seenT ?? 0, Date.parse(msgs[0].t));
  }
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (d) => {
      const k = d.toString();
      if (k === 'q' || k === 'Q' || k === '\u0003' || k === '\u001b') quit();
      if (k === 'a' || k === 'A') {
        mode = mode === 'agents' ? 'board' : 'agents';
        last = '';
        draw();
      }
      if (k === 'r' || k === 'R') {
        refresh();
        last = '';
        draw();
      }
    });
  }
  let last = '';
  function draw() {
    if (!st) refresh();
    view.now = Date.now();
    if (view.anim && view.now - view.anim.start >= PKT_MS) {
      view.flash = { id: view.anim.m.to, until: view.now + FLASH_MS, m: view.anim.m };
      view.anim = null;
    }
    if (queue.length > 4) queue.splice(0, queue.length - 4); // 밀린 메시지는 최근 4개만 보여 준다
    if (!view.anim && queue.length) view.anim = { m: queue.shift(), start: view.now };
    let frame;
    try {
      if (st.error) throw new Error(st.error);
      frame = mode === 'agents' ? renderAgents(st, out.columns, out.rows, view) : renderTerminal(st, out.columns, out.rows);
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
  refresh();
  draw();
  setInterval(() => {
    refresh();
    draw();
  }, interval);
  // 스피너와 날아가는 메시지는 에이전트 화면에서만 빠르게 다시 그린다
  setInterval(() => {
    view.spin++;
    if (mode === 'agents') draw();
  }, 120);
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
  --bg:#1a1918;--bg2:#222120;--panel:#262624;--panel-solid:#262624;--line:#3a3936;--line2:#4a4844;
  --text:#f5f4ef;--muted:#a8a69d;--faint:#6f6d66;
  --acc:#d97757;--acc-dim:rgba(217,119,87,.16);
  --run:#d97757;--run-dim:rgba(217,119,87,.13);
  --done:#4eba65;--done-dim:rgba(78,186,101,.13);
  --warn:#ffc107;--warn-dim:rgba(255,193,7,.12);
  --bad:#ff6b80;--bad-dim:rgba(255,107,128,.13);
  --ready:#b1b9f9;--ready-dim:rgba(177,185,249,.14);
  --u1:#d97757;--u2:#b1b9f9;--u3:#e58fb0;
  --track:#33322f;--grid:transparent;--glow:transparent;
}
[data-theme="light"]{
  --bg:#faf9f5;--bg2:#f0eee6;--panel:#ffffff;--panel-solid:#fff;--line:#e5e2d9;--line2:#d3cfc3;
  --text:#1f1e1d;--muted:#6b6962;--faint:#a3a097;
  --acc:#c6613f;--acc-dim:rgba(198,97,63,.12);
  --run:#c6613f;--run-dim:rgba(198,97,63,.10);
  --done:#2c7a3f;--done-dim:rgba(44,122,63,.10);
  --warn:#9a6700;--warn-dim:rgba(154,103,0,.10);
  --bad:#c2334d;--bad-dim:rgba(194,51,77,.10);
  --ready:#5763c9;--ready-dim:rgba(87,99,201,.10);
  --u1:#c6613f;--u2:#5763c9;--u3:#b23a6b;
  --track:#ebe8df;--grid:transparent;--glow:transparent;
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
.logo{flex:none;color:var(--acc);font-size:22px;line-height:1;width:22px;text-align:center}
.brand b{font-size:15px;letter-spacing:.18em}
.brand .cap{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.live{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--muted);white-space:nowrap}
.pulse{width:8px;height:8px;border-radius:50%;background:var(--acc);box-shadow:0 0 0 0 var(--acc);animation:ping 1.8s infinite}
.pulse.off{background:var(--bad);animation:none}
@keyframes ping{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--acc) 70%,transparent)}80%{box-shadow:0 0 0 9px transparent}100%{box-shadow:0 0 0 0 transparent}}
.usage{display:flex;align-items:center;gap:14px;font-size:12px;color:var(--muted);white-space:nowrap}
.usage .um{display:flex;align-items:center;gap:6px}
.usage .ut2{width:56px;height:5px;border-radius:3px;background:var(--track);overflow:hidden}
.usage .ut2 i{display:block;height:100%;border-radius:3px;background:var(--uc,var(--done))}
.usage .uv{color:var(--uc,var(--done));font-weight:700;font-variant-numeric:tabular-nums}
.usage .ur2{color:var(--faint)}
.usage.stale{opacity:.6}
@media (max-width:900px){.usage .ut2,.usage .ur2{display:none}}
@media (max-width:620px){.usage{display:none}}
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

/* agents — orc and subagents, Claude Code style */
.agents{position:relative;display:flex;flex-direction:column;gap:44px;padding:4px 0}
.agents svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible}
.agents .link{stroke:var(--line2);stroke-width:1.5;stroke-dasharray:3 5;fill:none;stroke-linejoin:round;transition:stroke .4s}
.agents .link.hot{stroke:var(--acc);stroke-dasharray:none}
.agents .pkt{fill:var(--acc);filter:drop-shadow(0 0 6px var(--acc))}
.agents .link.flow{stroke:var(--acc);stroke-width:2.5;stroke-dasharray:7 6;animation:march .5s linear infinite;opacity:1}
.agents .link.flow.rev{animation-name:march-rev}
@keyframes march{to{stroke-dashoffset:-13}} @keyframes march-rev{to{stroke-dashoffset:13}}
.bubble{position:absolute;z-index:3;opacity:0;transition:opacity .25s;transform:translate(14px,-50%);max-width:min(80%,340px);padding:4px 10px;border:1px solid var(--acc);border-radius:8px;background:var(--panel-solid);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;box-shadow:0 4px 18px rgba(0,0,0,.35)}
.bubble b{color:var(--acc)}
.flowbar{display:flex;align-items:center;gap:8px;min-height:22px;margin:-4px 0 10px;font-size:12.5px;color:var(--muted);white-space:nowrap;overflow:hidden}
.flowbar .trk{flex:none;width:120px;height:4px;border-radius:2px;background:var(--track);position:relative;overflow:hidden}
.flowbar .trk i{position:absolute;inset:0 auto 0 0;background:var(--acc);border-radius:2px}
.flowbar .who{font-weight:700} .flowbar .ftx{overflow:hidden;text-overflow:ellipsis;color:var(--text)}
.unit .ut .send{color:var(--acc);font-weight:700}
.unit .now{display:flex;gap:6px;align-items:baseline;margin-top:6px;padding-top:6px;border-top:1px dashed var(--line);font-size:12px;color:var(--muted);min-width:0}
.unit .now .el{color:var(--faint);flex:none} .unit .now .nl{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.unit .now.tool .nl{color:var(--text);font-weight:600} .unit .now .age{margin-left:auto;color:var(--faint);flex:none;font-variant-numeric:tabular-nums}
.unit{position:relative;overflow:hidden;cursor:pointer;transition:border-color .2s,box-shadow .2s}
.unit:hover{border-color:var(--muted)}
.unit.sel{outline:2px solid var(--uc);outline-offset:2px}
.unit .prog{position:absolute;left:0;bottom:0;height:3px;background:var(--uc);border-radius:0 2px 0 0;transition:width .6s}
.unit .prog::after{content:'';position:absolute;right:0;top:-2px;width:6px;height:7px;border-radius:50%;background:var(--uc);box-shadow:0 0 8px var(--uc)}
.unit .ur .el2{color:var(--faint);margin-left:4px}
.fchip{display:none;align-items:center;gap:6px;margin:12px 0 0;padding:3px 10px;border:1px solid var(--line2);border-radius:999px;font-size:12px;color:var(--muted);cursor:pointer;width:max-content}
.fchip.on{display:inline-flex} .fchip b{color:var(--text)}
.unit .now.idle{color:var(--faint)} .unit .now .mk{flex:none;color:var(--faint)} .unit .now.tool .mk{color:var(--acc)}
.arow{display:grid;grid-template-columns:repeat(var(--n,1),minmax(0,1fr));gap:14px;position:relative;z-index:1}
.arow.root{grid-template-columns:minmax(0,320px);justify-content:center}
.slot{min-width:0}
.unit{border:1px solid var(--line2);border-radius:10px;background:var(--panel-solid);padding:10px 12px;min-width:0}
.unit .uh{display:flex;align-items:center;gap:8px;min-width:0}
.unit .glyph{width:16px;text-align:center;color:var(--uc);flex:none}
.unit .un{font-weight:700;color:var(--uc);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.unit .ur{margin-left:auto;font-size:11px;color:var(--muted);white-space:nowrap}
.unit .role{font-size:12px;color:var(--muted);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.unit .ut{font-size:12.5px;margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.unit .ut .verb{color:var(--uc)}
.unit.st-standby{border-style:dashed} .unit.st-standby .ut{color:var(--faint)}
.unit.st-active{border-color:var(--uc);box-shadow:0 0 0 3px color-mix(in srgb,var(--uc) 14%,transparent)}
.unit.st-wait .ut{color:var(--muted)}
.unit.st-done{opacity:.72} .unit.st-done .glyph{color:var(--done)}
.unit.st-alert{border-color:var(--warn)} .unit.st-alert .ut{color:var(--warn)}
.unit.st-blocked{border-color:var(--bad)} .unit.st-blocked .ut{color:var(--bad)}
.unit.flash{animation:flash 1.1s ease-out}
@keyframes flash{0%{box-shadow:0 0 0 6px color-mix(in srgb,var(--uc) 35%,transparent)}100%{box-shadow:0 0 0 0 transparent}}
.k-orc{--uc:var(--u1)} .k-stage{--uc:var(--u2)} .k-review{--uc:var(--u3)}
.tx{margin-top:16px;border-top:1px solid var(--line);padding-top:10px;font-size:12.5px;max-height:380px;overflow:auto}
.msg{padding:5px 0}
.msg .mh{display:flex;gap:8px;align-items:baseline;min-width:0}
.msg .bul{color:var(--uc);flex:none}
.msg .who{font-weight:700;color:var(--uc);white-space:nowrap}
.msg .arr{color:var(--faint)} .msg .to{color:var(--muted);white-space:nowrap}
.msg .mt{margin-left:auto;color:var(--faint);font-variant-numeric:tabular-nums;white-space:nowrap}
.msg .mb{display:flex;gap:8px;padding-left:4px;color:var(--text);overflow-wrap:anywhere}
.msg .mb .el{color:var(--faint);flex:none}
.msg .inf{color:var(--faint);font-size:11px;white-space:nowrap}
.msg.new .mb{animation:fadein .6s ease-out}
@keyframes fadein{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}
@media (max-width:620px){
  .agents{gap:34px} .arow{gap:8px}
  .unit{padding:8px 9px} .unit .ur{display:none} .unit .role{display:none}
  .msg .inf{display:none}
}

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
    <div class="brand"><span class="logo" aria-hidden="true">✻</span><b>BINJARI</b><span class="cap" id="proj">mission control</span></div>
    <div class="usage ko" id="usage" title="Claude 사용 한도 (Claude Code 상태줄에서 받은 값)"></div>
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
    <div class="phead"><span class="cap">agents · orchestrator ↔ subagents</span><span class="cap ko" id="agSub"></span></div>
    <div class="flowbar ko" id="flowbar"></div>
    <div class="agents" id="agents">
      <svg id="agSvg" aria-hidden="true"></svg>
      <div class="arow root" id="rowOrc"></div>
      <div class="arow" id="rowStage"></div>
      <div class="arow" id="rowReview"></div>
    </div>
    <div class="fchip ko" id="fchip" role="button" tabindex="0"></div>
    <div class="tx" id="tx"></div>
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

  // ── agents: orchestrator ↔ subagents ──
  var VERB = { active: { orc: 'Orchestrating', stage: 'Building', review: 'Reviewing' }, wait: 'Waiting', standby: 'Idle', alert: 'No response', blocked: 'Blocked', done: 'Done' };
  var SPIN = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'], spinI = 0, seenT = null, agState = null, focusId = null;
  var SVGNS = 'http://www.w3.org/2000/svg';
  try { focusId = sessionStorage.getItem('board.focus') || null; } catch (e) {}
  function kindOf(id){ return id === 'orc' ? 'orc' : /:review$/.test(id) ? 'review' : 'stage'; }
  function label(id){ return id === 'orc' ? 'orchestrator' : /:review$/.test(id) ? id.slice(0, 3) + ' reviewer' : id + ' subagent'; }
  function nodeEl(id){ return document.querySelector('[data-agent="' + id + '"]'); }
  function anchor(id, side){
    var n = nodeEl(id); if (!n) return null; var box = $('agents').getBoundingClientRect(), r = n.getBoundingClientRect();
    return { x: r.left - box.left + r.width / 2, y: side === 'top' ? r.top - box.top : side === 'bottom' ? r.bottom - box.top : r.top - box.top + r.height / 2 };
  }
  // parent bottom → down → across → down → child top, with rounded corners
  function elbow(a, b){
    var my = Math.round((a.y + b.y) / 2), dx = b.x - a.x, r = Math.min(10, Math.abs(dx) / 2, Math.abs(my - a.y));
    if (Math.abs(dx) < 1) return 'M' + a.x + ' ' + a.y + ' L' + b.x + ' ' + b.y;
    var sx = dx > 0 ? 1 : -1;
    return 'M' + a.x + ' ' + a.y + ' L' + a.x + ' ' + (my - r) + ' Q' + a.x + ' ' + my + ' ' + (a.x + sx * r) + ' ' + my +
      ' L' + (b.x - sx * r) + ' ' + my + ' Q' + b.x + ' ' + my + ' ' + b.x + ' ' + (my + r) + ' L' + b.x + ' ' + b.y;
  }
  function pairOf(m){
    var child = m.from === 'orc' ? m.to : m.to === 'orc' ? m.from : /:review$/.test(m.from) ? m.from : m.to;
    return { parent: /:review$/.test(child) ? child.slice(0, 3) : 'orc', child: child };
  }
  function unit(id, u, role){
    var k = kindOf(id);
    var box = el('div', 'unit k-' + k + ' st-' + u.state + (focusId === id ? ' sel' : '')); box.setAttribute('data-agent', id);
    box.title = '클릭하면 이 에이전트의 메시지만 봅니다';
    var h = el('div', 'uh');
    h.appendChild(el('span', 'glyph', u.state === 'active' ? SPIN[spinI % SPIN.length] : u.state === 'done' ? '✓' : u.state === 'alert' || u.state === 'blocked' ? '!' : '○'));
    h.appendChild(el('span', 'un', label(id)));
    var ur = el('span', 'ur', u.state);
    if (u.state === 'active' && u.startedAt) { var e2 = el('span', 'el2', '· ' + dur(u.startedAt)); e2.setAttribute('data-from', u.startedAt); ur.appendChild(e2); }
    h.appendChild(ur);
    box.appendChild(h);
    if (role) box.appendChild(el('div', 'role ko', role));
    var p = el('div', 'ut ko'); p.appendChild(el('span', 'verb', (u.state === 'active' ? VERB.active[k] + '…' : (VERB[u.state] || u.state) + (u.state === 'wait' ? '…' : ' ·'))));
    if (u.text) p.appendChild(document.createTextNode(' ' + u.text));
    box.appendChild(p);
    if (u.now) {
      var nw = el('div', 'now' + (u.now.kind === 'tool' ? ' tool' : ''));
      nw.appendChild(el('span', 'el', '⎿'));
      nw.appendChild(el('span', 'mk', u.now.kind === 'tool' ? '▸' : u.now.kind === 'text' ? '✎' : '…'));
      nw.title = u.now.kind === 'tool' ? '실행 중인 도구' : u.now.kind === 'text' ? '답변 작성 중' : '생각 중 · 직전에 끝난 도구';
      nw.appendChild(el('span', 'nl ko', u.now.label));
      if (u.now.since) { var ag = el('span', 'age', ago(u.now.since)); ag.setAttribute('data-since', u.now.since); nw.appendChild(ag); }
      box.appendChild(nw);
    } else if (u.state === 'done' && u.startedAt && u.finishedAt) box.appendChild(el('div', 'now idle ko', '⎿ ✓ ' + dur(u.startedAt, u.finishedAt) + ' 걸림'));
    else box.appendChild(el('div', 'now idle', u.state === 'done' ? '⎿ ✓' : '⎿ —'));
    if (u.pct != null && u.status === 'IN_PROGRESS') { var pg = el('div', 'prog'); pg.style.width = Math.max(2, Math.min(100, u.pct)) + '%'; pg.title = u.pct + '%'; box.appendChild(pg); }
    box.addEventListener('click', function(){ setFocus(focusId === id ? null : id); });
    return box;
  }
  function setFocus(id){
    focusId = id; try { if (id) sessionStorage.setItem('board.focus', id); else sessionStorage.removeItem('board.focus'); } catch (e) {}
    if (agState) renderAgents({ agents: agState, _redraw: true });
  }
  $('fchip').addEventListener('click', function(){ setFocus(null); });
  $('fchip').addEventListener('keydown', function(e){ if (e.key === 'Enter' || e.key === ' ') setFocus(null); });
  var paths = {};
  function drawLinks(){
    if (!agState) return;
    var svg = $('agSvg'); var keep = Array.prototype.slice.call(svg.querySelectorAll('.pkt')); clear(svg); paths = {};
    var now = Date.now(), pairs = [];
    agState.stages.forEach(function(s){ pairs.push(['orc', s.id]); if (s.reviewer) pairs.push([s.id, s.id + ':review']); });
    pairs.forEach(function(pr){
      var a = anchor(pr[0], 'bottom'), b = anchor(pr[1], 'top'); if (!a || !b) return;
      var pa = document.createElementNS(SVGNS, 'path');
      pa.setAttribute('d', elbow(a, b));
      var hot = agState.messages.some(function(m){ return ((m.from === pr[0] && m.to === pr[1]) || (m.from === pr[1] && m.to === pr[0])) && now - Date.parse(m.t) < 15 * 60000; });
      var fl = flight ? (flight.m.from === pr[0] && flight.m.to === pr[1] ? ' flow' : flight.m.from === pr[1] && flight.m.to === pr[0] ? ' flow rev' : '') : '';
      pa.setAttribute('class', 'link' + (hot ? ' hot' : '') + fl);
      svg.appendChild(pa);
      paths[pr[0] + '>' + pr[1]] = pa;
    });
    keep.forEach(function(k){ svg.appendChild(k); });
  }
  var flight = null, received = null, PKT = 2400, RECV = 1800;
  function setUnitStatus(id, nodes){ var n = nodeEl(id); if (!n) return; var ut = n.querySelector('.ut'); if (!ut) return; clear(ut); nodes.forEach(function(x){ ut.appendChild(x); }); }
  function applyFlightStatus(){
    if (flight) setUnitStatus(flight.m.from, [el('span', 'send', 'Sending → ' + label(flight.m.to)), document.createTextNode(' ' + flight.m.text)]);
    if (received && Date.now() < received.until) setUnitStatus(received.m.to, [el('span', 'send', 'Received ✓'), document.createTextNode(' ' + received.m.text)]);
  }
  function sendPacket(m, delay){
    setTimeout(function(){
      var pr = pairOf(m), pa = paths[pr.parent + '>' + pr.child]; if (!pa) return;
      var len = pa.getTotalLength(), rev = m.from === pr.child;
      pa.classList.add('flow'); if (rev) pa.classList.add('rev');
      var svg = $('agSvg');
      var c = document.createElementNS(SVGNS, 'circle'); c.setAttribute('r', '6'); c.setAttribute('class', 'pkt'); svg.appendChild(c);
      var bub = el('div', 'bubble ko'); bub.appendChild(el('b', null, '✉ ')); bub.appendChild(document.createTextNode(m.text)); $('agents').appendChild(bub);
      var fb = $('flowbar'); clear(fb);
      fb.appendChild(el('span', null, '⇢'));
      var w1 = el('span', 'who k-' + kindOf(m.from), label(m.from)); w1.style.color = 'var(--uc)'; fb.appendChild(w1);
      var trk = el('span', 'trk'); var fill = el('i'); trk.appendChild(fill); fb.appendChild(trk);
      var w2 = el('span', 'who k-' + kindOf(m.to), label(m.to)); w2.style.color = 'var(--uc)'; fb.appendChild(w2);
      fb.appendChild(el('span', 'ftx', '"' + m.text + '"'));
      flight = { m: m }; applyFlightStatus();
      var t0 = null;
      function step(ts){
        if (t0 === null) t0 = ts; var k = Math.min(1, (ts - t0) / PKT); var e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        var cur = paths[pr.parent + '>' + pr.child] || pa; var L = cur.getTotalLength();
        var pt = cur.getPointAtLength((rev ? 1 - e : e) * L);
        c.setAttribute('cx', pt.x); c.setAttribute('cy', pt.y);
        bub.style.left = pt.x + 'px'; bub.style.top = pt.y + 'px';
        bub.style.opacity = k > .1 && k < .9 ? '1' : '0';
        fill.style.width = Math.round(k * 100) + '%';
        if (k < 1) { requestAnimationFrame(step); return; }
        if (c.parentNode) c.parentNode.removeChild(c);
        if (bub.parentNode) bub.parentNode.removeChild(bub);
        flight = null; received = { m: m, until: Date.now() + RECV };
        drawLinks();
        var u = nodeEl(m.to); if (u) { u.classList.remove('flash'); void u.offsetWidth; u.classList.add('flash'); }
        applyFlightStatus();
        setTimeout(function(){ if (!flight) clear($('flowbar')); if (agState) renderAgents({ agents: agState, _redraw: true }); }, RECV);
      }
      requestAnimationFrame(step);
    }, delay);
  }
  function renderAgents(st){
    var ag = st.agents; if (!ag) return; agState = ag;
    var ro = $('rowOrc'); clear(ro); ro.appendChild(unit('orc', ag.orc, '지휘자 · 차수를 맡기고 결과를 확인'));
    var rs = $('rowStage'), rr = $('rowReview'); clear(rs); clear(rr);
    var n = Math.max(1, ag.stages.length); rs.style.setProperty('--n', n); rr.style.setProperty('--n', n);
    var anyReview = false, ids = ['orc'];
    ag.stages.forEach(function(s){
      ids.push(s.id);
      var a = el('div', 'slot'); a.appendChild(unit(s.id, s, s.name)); rs.appendChild(a);
      var b = el('div', 'slot'); if (s.reviewer) { anyReview = true; ids.push(s.id + ':review'); b.appendChild(unit(s.id + ':review', s.reviewer, 'adversarial-reviewer')); } rr.appendChild(b);
    });
    rr.style.display = anyReview ? '' : 'none';
    if (!ag.stages.length) rs.appendChild(el('div', 'empty', 'no subagents yet'));
    if (focusId && ids.indexOf(focusId) < 0) focusId = null;
    $('agSub').textContent = ag.messages.length ? '상태 기록에서 재구성 · ' + ag.messages.length + '건' : '';
    var chip = $('fchip'); clear(chip);
    if (focusId) { chip.appendChild(el('b', null, label(focusId))); chip.appendChild(document.createTextNode(' 메시지만 보는 중 · 모두 보기 ✕')); chip.className = 'fchip ko on'; }
    else chip.className = 'fchip ko';

    var tx = $('tx'); clear(tx);
    var list = focusId ? ag.messages.filter(function(m){ return m.from === focusId || m.to === focusId; }) : ag.messages;
    if (!list.length) tx.appendChild(el('div', 'empty', focusId ? 'no messages for this agent' : 'no messages yet'));
    var fresh = [];
    ag.messages.forEach(function(m){ if (seenT !== null && Date.parse(m.t) > seenT) fresh.push(m); });
    list.slice(0, 24).forEach(function(m){
      var isNew = seenT !== null && Date.parse(m.t) > seenT;
      var d = el('div', 'msg k-' + kindOf(m.from) + (isNew ? ' new' : ''));
      var h = el('div', 'mh');
      h.appendChild(el('span', 'bul', '⏺'));
      h.appendChild(el('span', 'who', label(m.from)));
      h.appendChild(el('span', 'arr', '→'));
      h.appendChild(el('span', 'to', label(m.to)));
      h.appendChild(el('span', 'mt', hhmm(m.t)));
      d.appendChild(h);
      var b = el('div', 'mb'); b.appendChild(el('span', 'el', '⎿')); b.appendChild(el('span', 'ko', m.text));
      if (!m.inferred) b.appendChild(el('span', 'inf', 'msg'));
      d.appendChild(b);
      tx.appendChild(d);
    });
    drawLinks();
    applyFlightStatus();
    if (st._redraw) return;
    if (seenT === null && ag.messages[0]) fresh = [ag.messages[0]];
    fresh = fresh.reverse().slice(-4);
    fresh.forEach(function(m, i){ sendPacket(m, 300 + i * (PKT + 600)); });
    if (ag.messages[0]) seenT = Math.max(seenT || 0, Date.parse(ag.messages[0].t));
  }
  setInterval(function(){
    spinI++;
    Array.prototype.forEach.call(document.querySelectorAll('.unit.st-active .glyph'), function(g){ g.textContent = SPIN[spinI % SPIN.length]; });
  }, 130);
  setInterval(function(){
    Array.prototype.forEach.call(document.querySelectorAll('.unit [data-since]'), function(n){ n.textContent = ago(n.getAttribute('data-since')); });
    Array.prototype.forEach.call(document.querySelectorAll('.unit [data-from]'), function(n){ n.textContent = '· ' + dur(n.getAttribute('data-from')); });
  }, 1000);
  window.addEventListener('resize', drawLinks);

  function untilShort(iso){ if (!iso) return ''; var ms = Date.parse(iso) - Date.now(); if (!(ms > 0)) return '곧'; var m = Math.round(ms / 60000); if (m < 60) return m + 'm'; var h = Math.floor(m / 60); return h < 24 ? h + 'h' + pad(m % 60) + 'm' : Math.floor(h / 24) + 'd' + (h % 24) + 'h'; }
  function renderUsage(u){
    var box = $('usage'); clear(box);
    if (!u) { box.appendChild(el('span', 'ur2', '사용량 정보 없음')); box.title = 'Claude Code 상태줄(scripts/statusline.mjs)이 아직 사용량을 기록하지 않았어요'; return; }
    box.className = 'usage ko' + (Date.now() - Date.parse(u.at) > 15 * 60000 ? ' stale' : '');
    box.title = 'Claude 사용 한도 · ' + hhmm(u.at) + ' 기준' + (u.model ? ' · ' + u.model : '');
    [['5시간', u.fiveHour], ['주간', u.sevenDay]].forEach(function(x){
      var w = x[1]; if (!w) return;
      var left = 100 - w.usedPct, col = w.usedPct >= 85 ? 'var(--bad)' : w.usedPct >= 60 ? 'var(--warn)' : 'var(--done)';
      var m = el('span', 'um'); m.style.setProperty('--uc', col);
      m.appendChild(el('span', null, x[0]));
      var t = el('span', 'ut2'); var i = el('i'); i.style.width = left + '%'; t.appendChild(i); m.appendChild(t);
      m.appendChild(el('span', 'uv', left + '% 남음'));
      if (w.resetsAt) m.appendChild(el('span', 'ur2', '↻' + untilShort(w.resetsAt)));
      box.appendChild(m);
    });
  }

  function render(st){
    $('pulse').className = 'pulse';
    $('clock').textContent = 'LIVE · ' + hhmm(st.now) + ' · ' + (POLL/1000) + 's';
    $('proj').textContent = 'mission control · ' + st.project;
    renderUsage(st.usage);
    renderAgents(st);
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

#!/usr/bin/env node
// 진행 상황 보드용 상태 기록 도구 (의존성 없음, Node 18+).
// 차수를 수행하는 Claude가 단계마다 호출한다. 보드(scripts/board.mjs)가 이 기록을 읽어 화면에 그린다.
// 기록 위치: .runner/board/SNN.json (차수별 현재 상태), .runner/events.jsonl (한 줄씩 쌓이는 활동 기록)
// 이 도구가 실패해도 차수 작업은 계속한다. 상태 보고는 보조 수단이고, 진짜 기록은 PROGRESS.md와 커밋이다.
//
// 사용법
//   node scripts/status.mjs start  S05 [--worker main] [--model opus]   차수 시작
//   node scripts/status.mjs plan   S05 <체크포인트 수>                     PLAN.md를 쓴 직후
//   node scripts/status.mjs cp     S05 <끝낸 번호> "<한 줄 설명>"          체크포인트 커밋 직후
//   node scripts/status.mjs phase  S05 <plan|build|gate|review|report|extend> ["설명"]
//   node scripts/status.mjs note   S05 "<지금 하는 일>"                    진행률은 그대로, 현재 활동만 갱신
//   node scripts/status.mjs finish S05 <DONE|DONE_NEEDS_HUMAN|BLOCKED> "<한 줄 요약>"
//   node scripts/status.mjs runner "<메시지>"                             지휘자·스크립트의 기록
//   node scripts/status.mjs msg    <보낸쪽> <받는쪽> "<한 줄>" [--stage S05]  에이전트 사이 메시지(보드 agents 패널)
//          보낸쪽·받는쪽: orchestrator(또는 orc) | SNN(차수 서브에이전트) | SNN:review(그 차수의 검토자). 콘텐츠·비밀값은 적지 말 것
//   node scripts/status.mjs show   [S05]                                 기록 확인

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN_DIR = path.join(ROOT, '.runner');
const BOARD_DIR = path.join(RUN_DIR, 'board');
const EVENTS = path.join(RUN_DIR, 'events.jsonl');

const PHASES = ['plan', 'build', 'gate', 'review', 'report', 'extend'];
const FINAL = ['DONE', 'DONE_NEEDS_HUMAN', 'BLOCKED'];
const MAX_TEXT = 200;

function fail(msg) {
  console.error(`status: ${msg}`);
  console.error('도움말: node scripts/status.mjs help');
  process.exit(2);
}

function normStage(s) {
  if (!s) fail('차수 ID가 필요합니다 (예: S05)');
  const m = String(s).trim().toUpperCase().match(/^S?(\d{1,2})$/);
  if (!m) fail(`차수 ID 형식이 아닙니다: ${s}`);
  return 'S' + m[1].padStart(2, '0');
}

function clean(text) {
  // 한 줄로, 길이 제한. 비밀값을 적지 말 것(이 파일은 화면에 그대로 보인다).
  return String(text ?? '').replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_TEXT);
}

function parseFlags(args) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true';
      flags[key] = val;
    } else rest.push(a);
  }
  return { flags, rest };
}

function ensureDirs() {
  fs.mkdirSync(BOARD_DIR, { recursive: true });
}

function stageFile(id) {
  return path.join(BOARD_DIR, `${id}.json`);
}

function readStage(id) {
  try {
    return JSON.parse(fs.readFileSync(stageFile(id), 'utf8'));
  } catch {
    return null;
  }
}

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  for (let i = 0; i < 5; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      // Windows에서 보드가 파일을 읽는 순간 rename이 실패할 수 있다 → 잠깐 기다렸다 재시도
      const until = Date.now() + 40;
      while (Date.now() < until) { /* busy wait */ }
    }
  }
  fs.writeFileSync(file, data);
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
}

function percentOf(s) {
  if (s.status === 'BLOCKED') return s.blockedAt ?? 0;
  if (FINAL.includes(s.status)) return 100;
  const total = s.checkpoints?.total || 0;
  const done = Math.min(s.checkpoints?.done || 0, total || Infinity);
  switch (s.phase) {
    case 'plan': return 5;
    case 'build': return total ? Math.round(10 + (75 * done) / total) : 10;
    case 'gate': return 88;
    case 'review': return 92;
    case 'report': return 96;
    case 'extend': return 98;
    default: return 0;
  }
}

function event(stage, kind, text, worker, extra = {}) {
  ensureDirs();
  const line = JSON.stringify({ t: new Date().toISOString(), stage: stage || null, kind, text: clean(text), worker: worker || null, ...extra });
  fs.appendFileSync(EVENTS, line + '\n');
}

function save(s, kind, text) {
  s.updatedAt = new Date().toISOString();
  s.percent = percentOf(s);
  ensureDirs();
  writeAtomic(stageFile(s.id), JSON.stringify(s, null, 2) + '\n');
  event(s.id, kind, text, s.worker);
  console.log(`status: ${s.id} ${s.status} ${s.phase ?? ''} ${s.percent}%${text ? ' · ' + clean(text) : ''}`);
}

function base(id) {
  return readStage(id) ?? {
    id,
    status: 'TODO',
    phase: null,
    worker: 'main',
    model: null,
    checkpoints: { done: 0, total: 0 },
    activity: '',
    summary: '',
    startedAt: null,
    finishedAt: null,
    attempts: 0,
  };
}

const [cmd, ...argv] = process.argv.slice(2);
const { flags, rest } = parseFlags(argv);

try {
  switch (cmd) {
    case 'start': {
      const id = normStage(rest[0]);
      const s = base(id);
      const resumed = s.status === 'IN_PROGRESS';
      s.status = 'IN_PROGRESS';
      s.phase = resumed && s.phase ? s.phase : 'plan';
      s.worker = clean(flags.worker || s.worker || 'main');
      if (flags.model) s.model = clean(flags.model);
      s.startedAt = resumed && s.startedAt ? s.startedAt : new Date().toISOString();
      s.finishedAt = null;
      s.attempts = (s.attempts || 0) + 1;
      s.activity = resumed ? 'resuming' : 'planning';
      save(s, resumed ? 'resume' : 'start', resumed ? 'resumed' : 'started');
      break;
    }
    case 'plan': {
      const id = normStage(rest[0]);
      const total = Number.parseInt(rest[1], 10);
      if (!Number.isInteger(total) || total < 1 || total > 50) fail('체크포인트 수는 1~50 정수');
      const s = base(id);
      s.status = 'IN_PROGRESS';
      s.checkpoints = { done: Math.min(s.checkpoints?.done || 0, total), total };
      s.phase = 'build';
      s.activity = `checkpoint ${s.checkpoints.done + 1}/${total}`;
      save(s, 'plan', `plan ready · ${total} checkpoints`);
      break;
    }
    case 'cp': {
      const id = normStage(rest[0]);
      const n = Number.parseInt(rest[1], 10);
      if (!Number.isInteger(n) || n < 0) fail('체크포인트 번호는 0 이상 정수');
      const s = base(id);
      s.status = 'IN_PROGRESS';
      if (!s.checkpoints?.total || n > s.checkpoints.total) s.checkpoints = { done: n, total: Math.max(n, s.checkpoints?.total || 0) };
      else s.checkpoints.done = n;
      s.phase = 'build';
      const msg = clean(rest.slice(2).join(' '));
      s.activity = n < s.checkpoints.total ? `checkpoint ${n + 1}/${s.checkpoints.total}` : 'preparing gate';
      save(s, 'checkpoint', `checkpoint ${n}/${s.checkpoints.total}${msg ? ' · ' + msg : ''}`);
      break;
    }
    case 'phase': {
      const id = normStage(rest[0]);
      const ph = String(rest[1] || '').toLowerCase();
      if (!PHASES.includes(ph)) fail(`단계는 ${PHASES.join('|')} 중 하나`);
      const s = base(id);
      s.status = 'IN_PROGRESS';
      s.phase = ph;
      const label = { plan: 'planning', build: 'building', gate: 'running gate (pnpm verify)', review: 'adversarial review', report: 'writing report', extend: 'optional extensions' }[ph];
      const msg = clean(rest.slice(2).join(' '));
      s.activity = msg || label;
      save(s, 'phase', `phase → ${ph}${msg ? ' · ' + msg : ''}`);
      break;
    }
    case 'note': {
      const id = normStage(rest[0]);
      const s = base(id);
      const msg = clean(rest.slice(1).join(' '));
      if (!msg) fail('메모 내용이 필요합니다');
      s.activity = msg;
      save(s, 'note', msg);
      break;
    }
    case 'finish': {
      const id = normStage(rest[0]);
      const st = String(rest[1] || '').toUpperCase();
      if (!FINAL.includes(st)) fail(`결과는 ${FINAL.join('|')} 중 하나`);
      const s = base(id);
      if (st === 'BLOCKED') s.blockedAt = s.status === 'IN_PROGRESS' ? percentOf(s) : s.blockedAt ?? 0;
      else delete s.blockedAt;
      s.status = st;
      s.phase = null;
      s.finishedAt = new Date().toISOString();
      s.summary = clean(rest.slice(2).join(' '));
      s.activity = '';
      save(s, 'finish', `${st}${s.summary ? ' · ' + s.summary : ''}`);
      break;
    }
    case 'runner': {
      const msg = clean(rest.join(' '));
      if (!msg) fail('메시지가 필요합니다');
      event(null, 'runner', msg, flags.worker || 'runner');
      console.log(`status: runner · ${msg}`);
      break;
    }
    case 'msg': {
      const agent = (a) => {
        const v = String(a || '').trim();
        if (['orc', 'orchestrator'].includes(v.toLowerCase())) return 'orc';
        const m = v.toUpperCase().match(/^S?(\d{1,2})(:REVIEW)?$/);
        if (!m) fail(`에이전트는 orc | SNN | SNN:review 중 하나: ${v}`);
        return 'S' + m[1].padStart(2, '0') + (m[2] ? ':review' : '');
      };
      const from = agent(rest[0]);
      const to = agent(rest[1]);
      if (from === to) fail('보낸쪽과 받는쪽이 같습니다');
      const msg = clean(rest.slice(2).join(' '));
      if (!msg) fail('메시지가 필요합니다');
      const stage = flags.stage ? normStage(flags.stage) : [from, to].map((x) => x.slice(0, 3)).find((x) => /^S\d{2}$/.test(x)) || null;
      event(stage, 'msg', msg, null, { from, to });
      console.log(`status: msg ${from} → ${to} · ${msg}`);
      break;
    }
    case 'show': {
      if (rest[0]) console.log(JSON.stringify(readStage(normStage(rest[0])), null, 2));
      else {
        let files = [];
        try { files = fs.readdirSync(BOARD_DIR).filter((f) => /^S\d{2}\.json$/.test(f)).sort(); } catch { /* none */ }
        for (const f of files) {
          const s = readStage(f.slice(0, 3));
          if (s) console.log(`${s.id} ${s.status} ${s.percent ?? 0}% ${s.activity || s.summary || ''}`);
        }
        if (!files.length) console.log('아직 기록이 없습니다.');
      }
      break;
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h': {
      const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
      console.log(src.filter((l) => l.startsWith('//')).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
      break;
    }
    default:
      fail(`알 수 없는 명령: ${cmd}`);
  }
} catch (e) {
  // 상태 기록 실패는 작업 실패가 아니다. 알리고 0이 아닌 코드로 끝내되, 호출한 쪽은 무시하고 계속하면 된다.
  console.error(`status: 기록 실패 (${e?.message ?? e}) — 작업은 계속하세요`);
  process.exit(1);
}

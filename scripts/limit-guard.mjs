#!/usr/bin/env node
// Claude 사용 한도 감시 (의존성 없음, Node 18+). 러너(지휘자)가 백그라운드로 실행하고, 이 프로세스가 끝나면 지휘자가 깨어난다.
// 사용량은 scripts/statusline.mjs가 Claude Code 상태줄에서 받아 .runner/usage.json에 적어 둔 값을 읽는다(로그인 정보는 읽지 않음).
//
//   node scripts/limit-guard.mjs watch [--min-left 3] [--interval 30]
//       5시간·주간 한도 중 하나라도 남은 양이 min-left% 이하가 되면 'LIMIT_LOW ...'를 출력하고 끝난다.
//   node scripts/limit-guard.mjs wait-reset [--window five_hour|seven_day] [--grace 90] [--interval 30]
//       그 한도의 초기화 시각(+grace초)이 지나면 'LIMIT_RESET ...'를 출력하고 끝난다(시각을 모르면 30분 뒤).
//   공통: --file <usage.json 경로>  --max-hours 30 (이 시간이 지나면 'GUARD_TIMEOUT'으로 끝남)
// 종료 코드는 언제나 0이다. 출력 첫 단어로 무슨 일이 있었는지 구분한다.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const mode = args[0];
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
};
const FILE = path.resolve(opt('file', path.join(ROOT, '.runner', 'usage.json')));
const INTERVAL = Math.max(1, Number(opt('interval', 30))) * 1000;
const MAX_MS = Math.max(0.01, Number(opt('max-hours', 30))) * 3_600_000;
const started = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const local = (iso) => (iso ? new Date(iso).toLocaleString('ko-KR', { hour12: false }) : '?');

function readUsage() {
  try {
    const u = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return u && u.at ? u : null;
  } catch {
    return null;
  }
}

function done(line) {
  process.stdout.write(line + '\n');
  process.exit(0);
}

async function watch() {
  const minLeft = Number(opt('min-left', 3));
  for (;;) {
    const u = readUsage();
    // 상태줄 기록이 10분 넘게 낡았으면 판단하지 않고 기다린다(창이 닫혔거나 아직 기록 전)
    if (u && Date.now() - Date.parse(u.at) < 10 * 60_000) {
      for (const [name, w] of [
        ['five_hour', u.fiveHour],
        ['seven_day', u.sevenDay],
      ]) {
        if (w && Number.isFinite(w.usedPct) && 100 - w.usedPct <= minLeft) {
          done(
            `LIMIT_LOW window=${name} left=${100 - w.usedPct}% resets=${w.resetsAt ?? 'unknown'} (${local(w.resetsAt)})`,
          );
        }
      }
    }
    if (Date.now() - started > MAX_MS) done('GUARD_TIMEOUT watch');
    await sleep(INTERVAL);
  }
}

async function waitReset() {
  const key = opt('window', 'five_hour') === 'seven_day' ? 'sevenDay' : 'fiveHour';
  const graceMs = Math.max(0, Number(opt('grace', 90))) * 1000;
  // 시각만으로 판단한다: 초기화 뒤에도 Claude를 한 번 부르기 전까지는 상태줄의 사용 %가 예전 값으로 남을 수 있다
  const u = readUsage();
  const resetsAt = u?.[key]?.resetsAt ? Date.parse(u[key].resetsAt) : null;
  const until = resetsAt ? resetsAt + graceMs : started + 30 * 60_000; // 모르면 30분 기다린다
  process.stdout
    .write(`waiting for ${key} reset until ${local(new Date(until).toISOString())}${resetsAt ? '' : ' (reset time unknown)'}
`);
  for (;;) {
    const now = Date.now();
    if (now >= until)
      done(
        `LIMIT_RESET window=${key} at=${new Date(now).toISOString()} (${local(new Date(now).toISOString())})`,
      );
    if (now - started > MAX_MS) done('GUARD_TIMEOUT wait-reset');
    await sleep(Math.min(INTERVAL, Math.max(1000, until - now)));
  }
}

if (mode === 'watch') watch();
else if (mode === 'wait-reset') waitReset();
else {
  const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  process.stdout.write(
    src
      .filter((l) => l.startsWith('//'))
      .map((l) => l.replace(/^\/\/ ?/, ''))
      .join('\n') + '\n',
  );
}

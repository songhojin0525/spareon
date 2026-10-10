#!/usr/bin/env node
// Claude Code 상태줄 명령 (의존성 없음, Node 18+). .claude/settings.json의 statusLine이 실행한다.
// Claude Code가 stdin으로 넘기는 JSON의 rate_limits(5시간 세션 한도·주간 한도의 사용 %와 초기화 시각)를
// .runner/usage.json에 남겨 진행 보드(scripts/board.mjs)가 보여 주게 하고, 상태줄 한 줄을 출력한다.
// 로그인 정보는 읽지 않는다. 받은 JSON 중 사용량과 모델 이름만 저장한다. 어떤 오류가 나도 실패하지 않는다.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.runner', 'usage.json');
const color = !process.env.NO_COLOR;
const c = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const wordmark = () =>
  color ? '\x1b[1;97mSpare\x1b[0m\x1b[1;38;2;20;184;106mon\x1b[0m' : 'Spareon'; // 'Spare' white, 'on' brand green (docs/brand)
const gray = c('90');
const green = c('32');
const yellow = c('33');
const red = c('31');

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    const done = () => resolve(data);
    const t = setTimeout(done, 1500);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (data += d));
    process.stdin.on('end', () => {
      clearTimeout(t);
      done();
    });
    process.stdin.on('error', () => {
      clearTimeout(t);
      done();
    });
  });
}

// resets_at may come as epoch seconds, epoch ms or an ISO string
function resetMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const n = Number(v);
  if (Number.isFinite(n) && String(v).trim() !== '') return n < 1e12 ? n * 1000 : n;
  const p = Date.parse(v);
  return Number.isNaN(p) ? null : p;
}

function window(w) {
  if (!w || typeof w !== 'object') return null;
  const pct = Number(w.used_percentage);
  if (!Number.isFinite(pct)) return null;
  const r = resetMs(w.resets_at);
  return {
    usedPct: Math.max(0, Math.min(100, Math.round(pct))),
    resetsAt: r ? new Date(r).toISOString() : null,
  };
}

function until(iso) {
  if (!iso) return '';
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return '곧';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 ${m % 60}분`;
  return `${Math.floor(h / 24)}일 ${h % 24}시간`;
}

function meter(label, w) {
  const tone = w.usedPct >= 85 ? red : w.usedPct >= 60 ? yellow : green;
  const left = 100 - w.usedPct;
  return `${gray(label)} ${tone(`${left}% 남음`)}${w.resetsAt ? gray(` ↻${until(w.resetsAt)}`) : ''}`;
}

function currentStage() {
  try {
    const dir = path.join(ROOT, '.runner', 'board');
    for (const f of fs.readdirSync(dir).filter((x) => /^S\d{2}\.json$/.test(x))) {
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (s.status === 'IN_PROGRESS') return `${s.id} ${s.percent ?? 0}%`;
    }
  } catch {
    /* no board yet */
  }
  return '';
}

async function main() {
  let input;
  try {
    input = JSON.parse((await readStdin()) || '{}');
  } catch {
    input = {};
  }
  const rl = input.rate_limits || {};
  const five = window(rl.five_hour);
  const week = window(rl.seven_day);
  if (five || week) {
    try {
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      const tmp = `${OUT}.${process.pid}.tmp`;
      fs.writeFileSync(
        tmp,
        JSON.stringify(
          {
            at: new Date().toISOString(),
            fiveHour: five,
            sevenDay: week,
            model: input.model?.display_name ?? null,
          },
          null,
          2,
        ) + '\n',
      );
      fs.renameSync(tmp, OUT);
    } catch {
      /* the status line still prints */
    }
  }
  const parts = [wordmark()];
  const st = currentStage();
  if (st) parts.push(st);
  if (five) parts.push(meter('5시간', five));
  if (week) parts.push(meter('주간', week));
  if (!five && !week) parts.push(gray('사용량 정보 없음'));
  if (input.model?.display_name) parts.push(gray(input.model.display_name));
  process.stdout.write(parts.join(gray(' · ')) + '\n');
}

main().catch(() => process.stdout.write('spareon\n'));

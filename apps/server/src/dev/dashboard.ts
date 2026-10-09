/**
 * `GET /dev` — development dashboard (server-rendered HTML, refreshes every 2 seconds): nodes and their
 * state, recent jobs, account balances and the ledger sum per currency. Registered only when
 * NODE_ENV=development or DEV_DASHBOARD=1 (refused in production by config). Shows metadata only:
 * never prompts or outputs (absolute rule 4).
 */
import { desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import type { Db } from '../db/client.js';
import {
  accountBalances,
  jobAttempts,
  jobs,
  ledgerAccounts,
  ledgerPostings,
  models,
  nodes,
} from '../db/schema/index.js';
import { devNodeLabel } from '../fleet/nodes.js';
import type { SessionRegistry } from '../gateway/session.js';
import type { Clock } from '../lib/clock.js';
import type { SkeletonWorld } from '../skeleton/bootstrap.js';

export const DEV_DASHBOARD_PATH = '/dev';

export interface DevDashboardDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly sessions: SessionRegistry;
  readonly world: SkeletonWorld;
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/** µCR (bigint) → "1.234567 CR"-style text without floating point. */
export function formatMicro(amount: bigint, unit: string, decimals = 6): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = (abs / base).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = (abs % base).toString().padStart(decimals, '0');
  return `${negative ? '-' : ''}${whole}${decimals > 0 ? `.${frac}` : ''} ${unit}`;
}

const seoul = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
const fmtTime = (d: Date | null): string => (d === null ? '—' : seoul.format(d));

const STATE_KO: Record<string, string> = {
  offline: '오프라인',
  idle: '대기',
  customer: '손님 있음',
  running: '작업 중',
  paused: '일시정지',
  pending: '승인 대기',
  disabled: '꺼짐',
  quarantined: '격리',
  excluded: '제외',
  queued: '대기열',
  offered: '제안함',
  completed: '완료',
  failed: '실패',
  canceled: '취소',
  expired: '만료',
};
const ko = (s: string): string => STATE_KO[s] ?? s;

interface Snapshot {
  nodes: {
    id: string;
    state: string;
    eligible: boolean;
    lastSeenAt: Date | null;
    runtime: string | null;
  }[];
  jobs: {
    id: string;
    model: string;
    status: string;
    attempts: number;
    costUcr: bigint | null;
    failureCode: string | null;
    createdAt: Date;
    nodeId: string | null;
  }[];
  balances: { kind: string; ownerId: string | null; currency: string; balance: bigint }[];
  sums: { currency: string; total: bigint }[];
}

async function snapshot(db: Db, world: SkeletonWorld): Promise<Snapshot> {
  const nodeRows = await db
    .select({
      id: nodes.id,
      state: nodes.state,
      eligible: nodes.eligible,
      lastSeenAt: nodes.lastSeenAt,
      runtime: nodes.runtimeVersion,
    })
    .from(nodes)
    .where(eq(nodes.storeId, world.storeId))
    .orderBy(nodes.createdAt);
  const jobRows = await db
    .select({
      id: jobs.id,
      model: models.slug,
      status: jobs.status,
      attempts: jobs.attempts,
      costUcr: jobs.costUcr,
      failureCode: jobs.failureCode,
      createdAt: jobs.createdAt,
    })
    .from(jobs)
    .innerJoin(models, eq(models.id, jobs.modelId))
    .orderBy(desc(jobs.createdAt), desc(jobs.id))
    .limit(20);
  const lastNode = new Map<string, string>();
  if (jobRows.length > 0) {
    const attempts = await db
      .select({ jobId: jobAttempts.jobId, nodeId: jobAttempts.nodeId, seq: jobAttempts.seq })
      .from(jobAttempts)
      .where(
        inArray(
          jobAttempts.jobId,
          jobRows.map((j) => j.id),
        ),
      )
      .orderBy(jobAttempts.seq);
    for (const a of attempts) lastNode.set(a.jobId, a.nodeId);
  }
  const balances = await db
    .select({
      kind: ledgerAccounts.kind,
      ownerId: ledgerAccounts.ownerId,
      currency: ledgerAccounts.currency,
      balance: accountBalances.balance,
    })
    .from(ledgerAccounts)
    .innerJoin(accountBalances, eq(accountBalances.accountId, ledgerAccounts.id))
    .orderBy(ledgerAccounts.kind, ledgerAccounts.currency);
  const sums = await db
    .select({
      currency: ledgerPostings.currency,
      total: sql<string>`sum(${ledgerPostings.amount})::text`,
    })
    .from(ledgerPostings)
    .groupBy(ledgerPostings.currency);
  return {
    nodes: nodeRows,
    jobs: jobRows.map((j) => ({ ...j, nodeId: lastNode.get(j.id) ?? null })),
    balances,
    sums: sums.map((s) => ({ currency: s.currency, total: BigInt(s.total) })),
  };
}

const ACCOUNT_KO: Record<string, string> = {
  buyer_wallet: '구매자 지갑',
  buyer_hold: '구매자 홀드',
  store_pending: '매장 미성숙 수익',
  store_matured: '매장 확정 수익',
  platform_revenue: '플랫폼 매출',
  reserve: '준비금',
  fx_conversion: '통화 변환',
  test_topup_source: '테스트 충전 출처',
};

function money(currency: string, amount: bigint): string {
  return currency === 'KRW' || currency === 'USD'
    ? formatMicro(amount, currency === 'KRW' ? '원' : 'USD', 0)
    : formatMicro(amount, currency);
}

export function renderDashboard(s: Snapshot, sessions: SessionRegistry, now: Date): string {
  const e = escapeHtml;
  const nodeRows = s.nodes
    .map((n) => {
      const live = sessions.get(n.id);
      const modelsText = live === undefined ? '—' : [...live.models.keys()].join(', ') || '—';
      return `<tr><td>${e(devNodeLabel(n.id))}</td><td>${live === undefined ? '끊김' : '연결됨'}</td><td class="st-${e(n.state)}">${e(ko(n.state))}</td><td>${n.eligible ? '예' : '아니오'}</td><td>${e(modelsText)}</td><td>${e(n.runtime ?? '—')}</td><td>${e(fmtTime(n.lastSeenAt))}</td></tr>`;
    })
    .join('');
  const jobRowsHtml = s.jobs
    .map(
      (j) =>
        `<tr><td title="${e(j.id)}">${e(j.id.slice(-8))}</td><td>${e(j.model)}</td><td class="st-${e(j.status)}">${e(ko(j.status))}</td><td>${j.nodeId === null ? '—' : e(devNodeLabel(j.nodeId))}</td><td>${String(j.attempts)}</td><td>${j.costUcr === null ? '—' : e(formatMicro(j.costUcr, 'CR'))}</td><td>${e(j.failureCode ?? '')}</td><td>${e(fmtTime(j.createdAt))}</td></tr>`,
    )
    .join('');
  const balanceRows = s.balances
    .map(
      (b) =>
        `<tr><td>${e(ACCOUNT_KO[b.kind] ?? b.kind)}</td><td>${e(b.currency)}</td><td class="num">${e(money(b.currency, b.balance))}</td></tr>`,
    )
    .join('');
  const sumsOk = s.sums.every((x) => x.total === 0n);
  const sumRows = s.sums
    .map((x) => `<tr><td>${e(x.currency)}</td><td class="num">${e(x.total.toString())}</td></tr>`)
    .join('');
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta http-equiv="refresh" content="2">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>빈자리 개발용 대시보드</title>
<style>
body{font-family:system-ui,sans-serif;margin:16px;background:#fafaf7;color:#1f1f1c}
h1{font-size:20px}h2{font-size:16px;margin-top:24px}
table{border-collapse:collapse;width:100%;max-width:1100px;font-size:14px}
th,td{border-bottom:1px solid #ddd;padding:4px 8px;text-align:left}td.num{text-align:right;font-variant-numeric:tabular-nums}
.st-idle,.st-completed{color:#1a7f37}.st-running,.st-offered{color:#0b5cad}.st-failed,.st-expired,.st-offline{color:#b42318}
.ok{color:#1a7f37;font-weight:bold}.bad{color:#b42318;font-weight:bold}.note{color:#666;font-size:13px}
</style></head><body>
<h1>빈자리 개발용 대시보드 (S04 걷는 뼈대)</h1>
<p class="note">${e(fmtTime(now))} (서울) · 2초마다 새로 고침 · 개발용입니다. 프롬프트와 출력은 표시하지 않습니다.</p>
<h2>노드</h2>
<table><tr><th>이름</th><th>연결</th><th>상태</th><th>작업 가능</th><th>모델</th><th>런타임</th><th>마지막 수신</th></tr>${nodeRows || '<tr><td colspan="7">아직 연결된 PC가 없습니다.</td></tr>'}</table>
<h2>최근 작업</h2>
<table><tr><th>작업</th><th>모델</th><th>상태</th><th>노드</th><th>시도</th><th>과금</th><th>실패 사유</th><th>요청 시각</th></tr>${jobRowsHtml || '<tr><td colspan="8">아직 작업이 없습니다.</td></tr>'}</table>
<h2>잔액</h2>
<table><tr><th>계정</th><th>통화</th><th>잔액</th></tr>${balanceRows}</table>
<h2>원장 합 (통화별, 0이어야 정상)</h2>
<p class="${sumsOk ? 'ok' : 'bad'}">${sumsOk ? '정상: 모든 통화의 합이 0입니다.' : '이상: 합이 0이 아닌 통화가 있습니다.'}</p>
<table><tr><th>통화</th><th>최소 단위 합</th></tr>${sumRows}</table>
</body></html>`;
}

export function registerDevDashboard(app: FastifyInstance, deps: DevDashboardDeps): void {
  app.get(DEV_DASHBOARD_PATH, async (_request, reply) => {
    const html = renderDashboard(
      await snapshot(deps.db, deps.world),
      deps.sessions,
      deps.clock.now(),
    );
    return reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .header(
        'content-security-policy',
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      )
      .header('x-content-type-options', 'nosniff')
      .send(html);
  });
}

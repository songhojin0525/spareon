// `pnpm demo` — the S04 automatic demo: temporary Postgres → server → two fake-runtime agents (the Go
// agent when Go is installed, otherwise the TypeScript FakeAgent) → 10 requests → balances and ledger
// sums. Prints "10/10 완료, 원장 합 0" and exits 0 only when every request completed and every currency
// sums to zero. Development tool: no real money, nothing leaves this machine.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import * as protocol from '@binjari/protocol';
import { FakeAgent } from '@binjari/testkit';

import { formatMicro } from '../dev/dashboard.js';
import { devNodeLabel } from '../fleet/nodes.js';
import { systemClock } from '../lib/clock.js';
import { safeErrorText } from '../lib/safe-error.js';
import { type DevStack, startDevStack } from '../skeleton/dev-stack.js';

const REQUESTS = 10;
const AGENT_NAMES = ['demo-pc-1', 'demo-pc-2'];
const AGENT_DIR = fileURLToPath(new URL('../../../agent/', import.meta.url));

const out = (line = ''): void => {
  process.stdout.write(`${line}\n`);
};

function goAvailable(): boolean {
  const r = spawnSync('go', ['version'], { shell: false, encoding: 'utf8' });
  return r.status === 0;
}

interface Agents {
  readonly kind: 'go' | 'ts';
  stop(): Promise<void>;
}

function startGoAgents(stack: DevStack, dir: string): Agents {
  const exe = join(dir, process.platform === 'win32' ? 'binjari-agent.exe' : 'binjari-agent');
  out('Go 에이전트를 빌드합니다...');
  const build = spawnSync('go', ['build', '-o', exe, './cmd/binjari-agent'], {
    cwd: AGENT_DIR,
    shell: false,
    encoding: 'utf8',
  });
  if (build.status !== 0) throw new Error(`go build failed: ${build.stderr}`);
  const children: ChildProcess[] = AGENT_NAMES.map((name) => {
    const child = spawn(
      exe,
      [
        'run',
        '--server',
        stack.wsUrl,
        '--name',
        name,
        '--runtime',
        'fake',
        '--fake-delay',
        '200ms',
        '--always-available',
      ],
      {
        shell: false,
        // The secret goes through the environment, not the command line.
        env: { ...process.env, BINJARI_DEV_AGENT_SECRET: stack.agentSecret },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const prefix = (chunk: Buffer): void => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (line.trim() !== '') out(`  [${name}] ${line}`);
      }
    };
    child.stdout.on('data', prefix);
    child.stderr.on('data', prefix);
    return child;
  });
  return {
    kind: 'go',
    async stop() {
      await Promise.all(
        children.map(
          (c) =>
            new Promise<void>((resolve) => {
              if (c.exitCode !== null) {
                resolve();
                return;
              }
              c.once('exit', () => {
                resolve();
              });
              c.kill('SIGINT');
            }),
        ),
      );
    },
  };
}

async function startTsAgents(stack: DevStack): Promise<Agents> {
  const agents = await Promise.all(
    AGENT_NAMES.map((name) =>
      FakeAgent.connect({
        url: stack.wsUrl,
        secret: stack.agentSecret,
        name,
        protocol,
        behavior: { delayMs: 200 },
      }),
    ),
  );
  return {
    kind: 'ts',
    async stop() {
      await Promise.all(agents.map((a) => a.shutdown()));
    },
  };
}

async function waitForNodes(stack: DevStack, count: number, timeoutMs: number): Promise<void> {
  const end = performance.now() + timeoutMs;
  while (performance.now() < end) {
    const ready = stack.server.sessions.list().filter((s) => s.eligible && s.models.size > 0);
    if (ready.length >= count) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`only some agents connected within ${String(timeoutMs)} ms`);
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { ts: { type: 'boolean', default: false } } });
  const forcedTs = values.ts || process.env['BINJARI_DEMO_AGENT'] === 'ts';
  const useGo = !forcedTs && goAvailable();
  const dir = await mkdtemp(join(tmpdir(), 'binjari-demo-'));
  // A temporary database always: the demo never touches a configured DATABASE_URL.
  const stack = await startDevStack({
    env: {},
    clock: systemClock,
    port: 0,
    topupCr: 10n,
    log: out,
  });
  let agents: Agents | undefined;
  try {
    out(`서버: ${stack.httpUrl} (임시 Postgres)`);
    agents = useGo ? startGoAgents(stack, dir) : await startTsAgents(stack);
    out(
      `에이전트 2대 (${agents.kind === 'go' ? 'Go 에이전트, fake 런타임' : `TS FakeAgent (${forcedTs ? '--ts' : 'Go 없음'})`})`,
    );
    await waitForNodes(stack, AGENT_NAMES.length, 30_000);

    const { pool } = stack.app;
    const balance = async (kind: string, ownerId: string | null): Promise<bigint> => {
      const { rows } = await pool.query<{ b: string }>(
        `SELECT coalesce(sum(b.balance), 0)::text AS b FROM ledger_accounts a JOIN account_balances b ON b.account_id = a.id
          WHERE a.kind = $1 AND a.owner_id IS NOT DISTINCT FROM $2 AND a.currency = 'CR'`,
        [kind, ownerId],
      );
      return BigInt(rows[0]?.b ?? '0');
    };
    const walletBefore = await balance('buyer_wallet', stack.world.buyerId);

    out(`요청 ${String(REQUESTS)}개를 동시에 보냅니다...`);
    const results = await Promise.all(
      Array.from({ length: REQUESTS }, async (_, i) => {
        const res = await fetch(`${stack.httpUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${stack.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'fake-echo',
            messages: [{ role: 'user', content: `데모 질문 ${String(i + 1)}` }],
            max_tokens: 16,
          }),
        });
        const body = (await res.json()) as { id?: string };
        return { status: res.status, jobId: body.id?.replace(/^chatcmpl-/, '') };
      }),
    );
    const done = results.filter((r) => r.status === 200).length;

    const { rows: byNode } = await pool.query<{ node_id: string; n: number }>(
      `SELECT node_id, count(*)::int AS n FROM job_attempts WHERE status = 'completed' GROUP BY node_id ORDER BY node_id`,
    );
    const { rows: sums } = await pool.query<{ currency: string; total: string }>(
      'SELECT currency, sum(amount)::text AS total FROM ledger_postings GROUP BY currency ORDER BY currency',
    );
    const ledgerZero = sums.every((s) => BigInt(s.total) === 0n);

    out();
    out('작업을 처리한 PC');
    for (const r of byNode) out(`  ${devNodeLabel(r.node_id)}  ${String(r.n)}건`);
    out();
    out('잔액 (CR)');
    const rows: [string, bigint][] = [
      ['구매자 지갑 (시작)', walletBefore],
      ['구매자 지갑 (끝)', await balance('buyer_wallet', stack.world.buyerId)],
      ['구매자 홀드', await balance('buyer_hold', stack.world.buyerId)],
      ['매장 미성숙 수익 (70%)', await balance('store_pending', stack.world.storeId)],
      ['플랫폼 매출 (30%)', await balance('platform_revenue', null)],
    ];
    for (const [label, v] of rows)
      out(`  ${label.padEnd(22)} ${formatMicro(v, 'CR').padStart(20)}`);
    out();
    out('원장 합 (통화별, 최소 단위)');
    for (const s of sums) out(`  ${s.currency.padEnd(4)} ${s.total}`);
    out();
    const ok = done === REQUESTS && ledgerZero;
    out(
      ok
        ? `${String(done)}/${String(REQUESTS)} 완료, 원장 합 0`
        : `실패: ${String(done)}/${String(REQUESTS)} 완료, 원장 합 ${ledgerZero ? '0' : '0 아님'}`,
    );
    return ok ? 0 : 1;
  } finally {
    await agents?.stop();
    await stack.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`demo failed: ${safeErrorText(err)}\n`);
    process.exitCode = 1;
  },
);

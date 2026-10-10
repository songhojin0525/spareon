// `pnpm dev:server [--lan] [--port N]` — the walking-skeleton server for the friend-PC demo
// (docs/DEMO_0.md). Development only. Prints the dashboard URL, the API key and the agent command.
import { parseArgs } from 'node:util';

import { systemClock } from '../lib/clock.js';
import { safeErrorText } from '../lib/safe-error.js';
import { DevStackError, startDevStack } from '../skeleton/dev-stack.js';

const out = (line = ''): void => {
  process.stdout.write(`${line}\n`);
};

const { values } = parseArgs({
  options: {
    lan: { type: 'boolean', default: false },
    port: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});
if (values.help) {
  out('usage: pnpm dev:server [--lan] [--port 8080]');
  out('  --lan    listen on all network interfaces so other PCs can connect (development only)');
  out(
    'env: DATABASE_URL (local; default: temporary embedded Postgres), DEV_AGENT_SECRET; other secrets are generated when unset',
  );
  process.exit(0);
}

try {
  const stack = await startDevStack({
    env: process.env,
    clock: systemClock,
    lan: values.lan,
    ...(values.port === undefined ? {} : { port: Number.parseInt(values.port, 10) }),
    logger: true,
    log: out,
  });
  out();
  out('=== Spareon 개발용 서버가 켜졌습니다 ===');
  out(`대시보드:      ${stack.httpUrl}/dev`);
  out(`구매자 API:    ${stack.httpUrl}/v1/chat/completions`);
  out(`API 키:        ${stack.apiKey}  (개발용 구매자, 켤 때마다 새 키)`);
  out(`에이전트 비밀: ${stack.agentSecret}`);
  if (stack.generatedSecrets.includes('DEV_AGENT_SECRET')) {
    out(
      '(에이전트 비밀은 이번 실행용으로 새로 만들었습니다. 고정하려면 DEV_AGENT_SECRET 환경변수를 설정하세요.)',
    );
  }
  if (stack.lanWsUrls.length > 0) {
    out('같은 와이파이의 친구 PC는 아래 주소 중 하나로 접속합니다:');
    for (const u of stack.lanWsUrls) out(`  ${u}`);
    out('주의: LAN에 열려 있습니다. 데모가 끝나면 Ctrl+C로 끄세요.');
  } else {
    out(`에이전트 주소: ${stack.wsUrl}  (이 PC에서만 접속 가능. 다른 PC는 --lan)`);
  }
  if (stack.temporaryDatabase) out('DB: 임시 Postgres (끄면 장부도 지워집니다)');
  out('끄려면 Ctrl+C');
  const stop = (): void => {
    out('stopping...');
    stack.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch (err) {
  process.stderr.write(`${err instanceof DevStackError ? err.message : safeErrorText(err)}\n`);
  process.exit(1);
}

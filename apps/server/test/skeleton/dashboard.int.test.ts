import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { chatBody, type Harness, startHarness } from '../support/skeleton.js';

describe('/dev dashboard', () => {
  let on: Harness;
  let off: Harness;

  beforeAll(async () => {
    [on, off] = await Promise.all([startHarness({ dashboard: true }), startHarness()]);
  });
  afterAll(async () => {
    await Promise.all([on.close(), off.close()]);
  });

  it('does not exist unless enabled (NODE_ENV=test without DEV_DASHBOARD)', async () => {
    expect((await fetch(`${off.baseUrl}/dev`)).status).toBe(404);
  });

  it('shows nodes, jobs, balances and a zero ledger sum, but never prompts or outputs', async () => {
    const agent = await on.agent('dash-1');
    const secret = 'SECRET-PROMPT-TEXT-12345';
    const res = await on.chat(chatBody(secret));
    expect(res.status).toBe(200);
    const answer = ((await res.json()) as { choices: { message: { content: string } }[] })
      .choices[0]?.message.content;
    const page = await fetch(`${on.baseUrl}/dev`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await page.text();
    expect(html).toContain('http-equiv="refresh" content="2"');
    expect(html).toContain(`PC-${agent.nodeId.slice(-6)}`);
    expect(html).toContain('연결됨');
    expect(html).toContain('fake-echo');
    expect(html).toContain('완료');
    expect(html).toContain('0.010000 CR');
    expect(html).toContain('정상: 모든 통화의 합이 0입니다.');
    expect(html).not.toContain(secret);
    expect(answer).toBeDefined();
    expect(html).not.toContain(answer ?? '');
  });
});

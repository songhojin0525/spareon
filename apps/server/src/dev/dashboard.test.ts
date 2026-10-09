import { describe, expect, it } from 'vitest';

import { SessionRegistry } from '../gateway/session.js';
import { escapeHtml, formatMicro, renderDashboard } from './dashboard.js';

describe('dev dashboard helpers', () => {
  it('formats minimal units without floating point', () => {
    expect(formatMicro(10_000n, 'CR')).toBe('0.010000 CR');
    expect(formatMicro(1_234_567_890n, 'CR')).toBe('1,234.567890 CR');
    expect(formatMicro(-7_000n, 'CR')).toBe('-0.007000 CR');
    expect(formatMicro(140_000n, '원', 0)).toBe('140,000 원');
  });

  it('escapes HTML', () => {
    expect(escapeHtml(`<script>"x"&'y'</script>`)).toBe(
      '&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;',
    );
  });

  it('renders node-reported text escaped and flags an unbalanced ledger', () => {
    const html = renderDashboard(
      {
        nodes: [
          {
            id: '019b76da-a800-75fd-927b-f75287937db3',
            state: 'idle',
            eligible: true,
            lastSeenAt: new Date('2026-10-10T00:00:00Z'),
            runtime: '<img src=x onerror=alert(1)>',
          },
        ],
        jobs: [],
        balances: [],
        sums: [{ currency: 'CR', total: 5n }],
      },
      new SessionRegistry(),
      new Date('2026-10-10T00:00:00Z'),
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).toContain('PC-937db3');
    expect(html).toContain('이상: 합이 0이 아닌 통화가 있습니다.');
    expect(html).toContain('2026. 10. 10. 09:00:00');
  });
});

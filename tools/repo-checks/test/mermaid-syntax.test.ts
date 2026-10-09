// Parses every ```mermaid block in the repository's Markdown with the real mermaid parser.
// check-docs.mjs only checks structure (closed, not empty, state transition actors) because it must
// stay dependency-free; syntax needs mermaid itself, which needs a DOM (jsdom) for DOMPurify.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';
import { beforeAll, describe, expect, it } from 'vitest';

import { extractMermaidBlocks, listMarkdown } from '../../../scripts/check-docs.mjs';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

interface MermaidApi {
  initialize(config: { startOnLoad: boolean }): void;
  parse(text: string): Promise<unknown>;
}

let mermaid: MermaidApi;

beforeAll(async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  const mod = (await import('mermaid')) as unknown as { default: MermaidApi };
  mermaid = mod.default;
  mermaid.initialize({ startOnLoad: false });
  // Loading mermaid + jsdom can take over a minute while `pnpm verify` runs every package's tests in
  // parallel (the server's database tests start several Postgres instances). Only the load is slow.
}, 180_000);

const parseError = async (source: string): Promise<string | null> => {
  try {
    await mermaid.parse(source);
    return null;
  } catch (err) {
    return (err instanceof Error ? err.message : String(err)).split('\n').slice(0, 4).join(' ');
  }
};

describe('mermaid syntax', () => {
  it('the parser rejects broken diagrams (proves the check has teeth)', async () => {
    expect(await parseError('sequenceDiagram\n  A->>B: hi')).toBeNull();
    expect(await parseError('stateDiagram-v2\n  [*] --> idle : [서버] 시작')).toBeNull();
    expect(await parseError('sequenceDiagram\n  A->>: broken')).not.toBeNull();
    expect(await parseError('flowchart TD\n  a --> ')).not.toBeNull();
    expect(await parseError('notADiagram\n  a')).not.toBeNull();
  });

  it('every mermaid block in the repository parses', async () => {
    const failures: string[] = [];
    let count = 0;
    for (const file of listMarkdown(repoRoot)) {
      const text = readFileSync(path.join(repoRoot, file), 'utf8');
      for (const block of extractMermaidBlocks(text)) {
        count += 1;
        const error = await parseError(block.body.join('\n'));
        if (error !== null) failures.push(`${file}:${block.line}: ${error}`);
      }
    }
    expect(failures).toEqual([]);
    // Sanity: the design documents contain diagrams, so finding none means extraction broke.
    expect(count).toBeGreaterThan(0);
  }, 120_000);
});

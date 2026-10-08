import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// Structural checks for the CI workflow (actionlint covers syntax; run `pnpm lint:ci` when Go is available).
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

interface Step {
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}
interface Job {
  'runs-on': string;
  steps: Step[];
  defaults?: { run?: { 'working-directory'?: string } };
}
interface Workflow {
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

const wf = parse(readFileSync(`${repoRoot}.github/workflows/ci.yml`, 'utf8')) as Workflow;
const rootPkg = JSON.parse(readFileSync(`${repoRoot}package.json`, 'utf8')) as {
  packageManager?: string;
  scripts?: Record<string, string>;
};

describe('ci.yml', () => {
  it('has least-privilege permissions and cancels superseded runs', () => {
    expect(wf.permissions).toEqual({ contents: 'read' });
    expect(wf.concurrency?.['cancel-in-progress']).toBe(true);
    expect(wf.concurrency?.group).toContain('github.ref');
  });

  it('linux job installs with a frozen lockfile and runs pnpm verify with Go required', () => {
    const linux = wf.jobs['linux'];
    expect(linux?.['runs-on']).toBe('ubuntu-latest');
    const runs = linux?.steps.map((s) => s.run) ?? [];
    expect(runs).toContain('pnpm install --frozen-lockfile');
    const verify = linux?.steps.find((s) => s.run === 'pnpm verify');
    expect(verify?.env?.['REQUIRE_GO']).toBe('1');
    const uses = linux?.steps.map((s) => s.uses ?? '') ?? [];
    expect(uses.some((u) => u.startsWith('actions/setup-go@'))).toBe(true);
    expect(uses.some((u) => u.startsWith('pnpm/action-setup@'))).toBe(true);
    const node = linux?.steps.find((s) => s.uses?.startsWith('actions/setup-node@') === true);
    expect(node?.with?.['cache']).toBe('pnpm');
  });

  it('windows job runs go test in apps/agent', () => {
    const win = wf.jobs['windows'];
    expect(win?.['runs-on']).toBe('windows-latest');
    expect(win?.defaults?.run?.['working-directory']).toBe('apps/agent');
    expect(win?.steps.map((s) => s.run)).toContain('go test ./...');
  });

  it('pins every action to a version', () => {
    for (const job of Object.values(wf.jobs)) {
      for (const step of job.steps) {
        if (step.uses !== undefined) expect(step.uses).toMatch(/@v?\d/);
      }
    }
  });

  it('root package.json pins pnpm and exposes the verify entry point', () => {
    expect(rootPkg.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    expect(rootPkg.scripts?.['verify']).toBe('node scripts/verify.mjs');
    expect(rootPkg.scripts?.['board']).toBe('node scripts/board.mjs');
    expect(rootPkg.scripts?.['board:web']).toBe('node scripts/board.mjs --web --open');
  });
});

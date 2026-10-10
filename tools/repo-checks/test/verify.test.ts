import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import {
  isNotFound,
  isSuccess,
  MIN_NODE,
  nodeVersionAtLeast,
  parseArgs,
  resolvePnpm,
  runAll,
  runCommand,
  runGo,
  runStep,
  summarize,
} from '../../../scripts/verify.mjs';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const verifyScript = path.join(repoRoot, 'scripts', 'verify.mjs');

type Spec = Parameters<typeof runCommand>[0];
type Result = Awaited<ReturnType<typeof runCommand>>;

const ok = (stdout = ''): Result => ({ code: 0, signal: null, error: undefined, stdout });
const exit = (code: number): Result => ({ code, signal: null, error: undefined, stdout: '' });

/** Fake runner: decides each command's result by a predicate and records every call. */
function fakeRunner(decide: (spec: Spec) => Result) {
  const calls: Spec[] = [];
  const runner = (spec: Spec): Promise<Result> => {
    calls.push(spec);
    return Promise.resolve(decide(spec));
  };
  return { runner, calls };
}

const node = { command: process.execPath, prefixArgs: [] };

describe('parseArgs', () => {
  it('accepts the documented flags', () => {
    expect(parseArgs([])).toEqual({ only: 'all', quick: false, help: false });
    expect(parseArgs(['--quick', '--only=go'])).toEqual({ only: 'go', quick: true, help: false });
    expect(parseArgs(['--only=ts']).only).toBe('ts');
  });

  it('rejects unknown flags and values instead of ignoring them', () => {
    expect(() => parseArgs(['--qiuck'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--only=rust'])).toThrow(/invalid --only/);
  });
});

describe('isSuccess (no swallowed failures)', () => {
  it('is true only for exit code 0 without signal or spawn error', () => {
    expect(isSuccess(ok())).toBe(true);
    expect(isSuccess(exit(1))).toBe(false);
    expect(isSuccess(exit(255))).toBe(false);
    expect(isSuccess({ code: null, signal: 'SIGKILL', error: undefined })).toBe(false);
    expect(isSuccess({ code: null, signal: null, error: undefined })).toBe(false);
    expect(isSuccess({ code: 0, signal: null, error: new Error('spawn ENOENT') })).toBe(false);
  });
});

describe('runCommand with real processes', () => {
  it('reports the real exit code', async () => {
    const r = await runCommand({ cmd: node, args: ['-e', 'process.exit(3)'], captureStdout: true });
    expect(r.code).toBe(3);
    expect(isSuccess(r)).toBe(false);
  });

  it('reports a missing executable as an error, not a pass', async () => {
    const r = await runCommand({
      cmd: { command: 'spareon-definitely-missing-cmd', prefixArgs: [] },
      args: [],
    });
    expect(r.error).toBeInstanceOf(Error);
    expect(isSuccess(r)).toBe(false);
  });

  it('does not interpret shell syntax (shell: false)', async () => {
    const r = await runCommand({
      cmd: node,
      args: ['-e', 'process.stdout.write(process.argv[1] ?? "")', 'a && exit 1 | b'],
      captureStdout: true,
    });
    expect(isSuccess(r)).toBe(true);
    expect(r.stdout).toBe('a && exit 1 | b');
  });
});

describe('runStep', () => {
  it('fails on the first failing command and does not run the rest', async () => {
    const { runner, calls } = fakeRunner((s) => (s.args[0] === 'two' ? exit(2) : ok()));
    const r = await runStep(
      'x',
      [
        { cmd: node, args: ['one'] },
        { cmd: node, args: ['two'] },
        { cmd: node, args: ['three'] },
      ],
      undefined,
      runner,
    );
    expect(r.status).toBe('FAIL');
    expect(r.detail).toMatch(/exit code 2/);
    expect(calls.map((c) => c.args[0])).toEqual(['one', 'two']);
  });

  it('fails when the extra check finds a problem even if the exit code is 0', async () => {
    const { runner } = fakeRunner(() => ok('main.go\n'));
    const r = await runStep(
      'fmt',
      [{ cmd: node, args: [] }],
      (res) => res.stdout || undefined,
      runner,
    );
    expect(r.status).toBe('FAIL');
  });
});

describe('summarize', () => {
  it('exits 1 if any step failed', () => {
    const s = summarize([
      { name: 'a', status: 'PASS', ms: 1 },
      { name: 'b', status: 'FAIL', ms: 1, detail: 'boom' },
    ]);
    expect(s.exitCode).toBe(1);
    expect(s.text).toMatch(/RESULT: FAIL/);
    expect(s.text).toMatch(/b\s+FAIL/);
  });

  it('passes with skipped steps but says so loudly', () => {
    const s = summarize([
      { name: 'a', status: 'PASS', ms: 1 },
      { name: 'go:test', status: 'SKIPPED', ms: 0 },
    ]);
    expect(s.exitCode).toBe(0);
    expect(s.text).toMatch(/SKIPPED — this is NOT a full verification/);
  });

  it('fails when every step was skipped (nothing verified)', () => {
    const s = summarize([{ name: 'go:test', status: 'SKIPPED', ms: 0 }]);
    expect(s.exitCode).toBe(1);
    expect(s.text).toMatch(/nothing was verified/);
  });

  it('treats an empty run as a failure', () => {
    expect(summarize([]).exitCode).toBe(1);
  });
});

describe('Go steps', () => {
  const goMissing = (s: Spec): Result =>
    s.cmd.command === 'go' || s.cmd.command === 'gofmt'
      ? {
          code: null,
          signal: null,
          error: Object.assign(new Error('spawn go ENOENT'), { code: 'ENOENT' }),
          stdout: '',
        }
      : ok();

  it('are SKIPPED when Go is missing', async () => {
    const { runner } = fakeRunner(goMissing);
    const r = await runGo({}, runner);
    expect(r.map((x) => x.status)).toEqual(['SKIPPED', 'SKIPPED', 'SKIPPED', 'SKIPPED']);
  });

  it('FAIL when Go is missing and REQUIRE_GO=1', async () => {
    const { runner } = fakeRunner(goMissing);
    const r = await runGo({ REQUIRE_GO: '1' }, runner);
    expect(r.every((x) => x.status === 'FAIL')).toBe(true);
    expect(summarize(r).exitCode).toBe(1);
  });

  it('fail gofmt when files need formatting', async () => {
    const { runner } = fakeRunner((s) =>
      s.cmd.command === 'gofmt' ? ok('cmd/spareon-agent/main.go\n') : ok('go version go1.27.0'),
    );
    const r = await runGo({}, runner);
    expect(r.find((x) => x.name === 'go:gofmt')?.status).toBe('FAIL');
    expect(r.find((x) => x.name === 'go:gofmt')?.detail).toMatch(/main\.go/);
  });

  it('cross-compiles for windows/amd64 and runs vet and test', async () => {
    const { runner, calls } = fakeRunner((s) =>
      ok(s.args[0] === 'version' ? 'go version go1.27.0' : ''),
    );
    const r = await runGo({}, runner);
    expect(r.every((x) => x.status === 'PASS')).toBe(true);
    const build = calls.find((c) => c.args[0] === 'build');
    expect(build?.env).toMatchObject({ GOOS: 'windows', GOARCH: 'amd64' });
    expect(calls.map((c) => c.args.join(' '))).toEqual(
      expect.arrayContaining(['vet ./...', 'test ./...', 'build ./...', '-l .']),
    );
  });
});

describe('Go probe failures other than "not found"', () => {
  it('FAIL instead of SKIPPED when go exists but is broken', async () => {
    const broken = fakeRunner((s) => (s.cmd.command === 'go' ? exit(1) : ok()));
    const r = await runGo({}, broken.runner);
    expect(r).toEqual([expect.objectContaining({ name: 'go:probe', status: 'FAIL' })]);
    const eacces = fakeRunner(() => ({
      code: null,
      signal: null,
      error: Object.assign(new Error('spawn go EACCES'), { code: 'EACCES' }),
      stdout: '',
    }));
    expect((await runGo({}, eacces.runner))[0]?.status).toBe('FAIL');
    expect(isNotFound({ error: Object.assign(new Error('x'), { code: 'EACCES' }) })).toBe(false);
  });
});

describe('Node version check', () => {
  it('compares versions numerically', () => {
    expect(nodeVersionAtLeast('22.18.0', '22.13.0')).toBe(true);
    expect(nodeVersionAtLeast('22.13.0', '22.13.0')).toBe(true);
    expect(nodeVersionAtLeast('22.9.0', '22.13.0')).toBe(false);
    expect(nodeVersionAtLeast('20.19.1', '22.13.0')).toBe(false);
    expect(nodeVersionAtLeast('24.0.0', '22.13.0')).toBe(true);
  });

  it('matches package.json engines.node', () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      engines: { node: string };
    };
    expect(pkg.engines.node).toBe(`>=${MIN_NODE}`);
  });
});

describe('runAll', () => {
  const pnpm = { command: process.execPath, prefixArgs: ['pnpm.cjs'] };

  it('runs format, docs, lint, typecheck, test in that order', async () => {
    const { runner } = fakeRunner(() => ok());
    const r = await runAll({ only: 'ts', quick: false, help: false }, { env: {}, runner, pnpm });
    expect(r.map((x) => x.name)).toEqual(['format:check', 'docs', 'lint', 'typecheck', 'test']);
  });

  it('keeps running later steps after a failure and reports every failure', async () => {
    const { runner } = fakeRunner((s) => (s.args.includes('lint') ? exit(1) : ok()));
    const r = await runAll({ only: 'ts', quick: false, help: false }, { env: {}, runner, pnpm });
    expect(r.find((x) => x.name === 'lint')?.status).toBe('FAIL');
    expect(r.find((x) => x.name === 'test')?.status).toBe('PASS');
    expect(summarize(r).exitCode).toBe(1);
  });

  it('--quick tells vitest to exclude integration tests; full mode forces them on', async () => {
    const quick = fakeRunner(() => ok());
    await runAll({ only: 'ts', quick: true, help: false }, { env: {}, runner: quick.runner, pnpm });
    expect(quick.calls.find((c) => c.args.includes('test'))?.env).toEqual({
      SPAREON_TEST_QUICK: '1',
    });
    const full = fakeRunner(() => ok());
    await runAll({ only: 'ts', quick: false, help: false }, { env: {}, runner: full.runner, pnpm });
    expect(full.calls.find((c) => c.args.includes('test'))?.env).toEqual({
      SPAREON_TEST_QUICK: '0',
    });
  });

  it('fails lint/typecheck/test when pnpm cannot be found', async () => {
    const { runner } = fakeRunner(() => ok());
    const r = await runAll(
      { only: 'ts', quick: false, help: false },
      { env: {}, runner, pnpm: null },
    );
    expect(r.filter((x) => x.status === 'FAIL').map((x) => x.name)).toEqual([
      'lint',
      'typecheck',
      'test',
    ]);
  });
});

describe('resolvePnpm', () => {
  const execPath = 'C:\\nodejs\\node.exe';

  it('prefers npm_execpath (set by `pnpm verify`) and runs JS entry points with node', () => {
    const p = 'C:\\pnpm\\bin\\pnpm.cjs';
    expect(
      resolvePnpm({
        env: { npm_execpath: p },
        platform: 'win32',
        execPath,
        exists: (f: string) => f === p,
      }),
    ).toEqual({ command: execPath, prefixArgs: [p] });
  });

  it('ignores npm_execpath that belongs to npm', () => {
    const r = resolvePnpm({
      env: { npm_execpath: 'C:\\npm\\bin\\npm-cli.js', Path: '' },
      platform: 'win32',
      execPath,
      exists: () => false,
    });
    expect(r).toBeNull();
  });

  it('finds an npm-global pnpm on Windows PATH without using pnpm.cmd', () => {
    const cjs = 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\pnpm\\bin\\pnpm.cjs';
    const r = resolvePnpm({
      env: { Path: 'C:\\Windows;C:\\Users\\u\\AppData\\Roaming\\npm' },
      platform: 'win32',
      execPath,
      exists: (f: string) => f === cjs,
    });
    expect(r).toEqual({ command: execPath, prefixArgs: [cjs] });
  });

  it('falls back to the corepack bundled with node', () => {
    const corepack = 'C:\\nodejs\\node_modules\\corepack\\dist\\corepack.js';
    const r = resolvePnpm({
      env: { Path: 'C:\\Windows' },
      platform: 'win32',
      execPath,
      exists: (f: string) => f === corepack,
    });
    expect(r).toEqual({ command: execPath, prefixArgs: [corepack, 'pnpm'] });
  });

  it('uses a pnpm executable on POSIX PATH', () => {
    const r = resolvePnpm({
      env: { PATH: '/usr/bin:/opt/pnpm' },
      platform: 'linux',
      execPath: '/usr/bin/node',
      exists: (f: string) => f === '/opt/pnpm/pnpm',
    });
    expect(r).toEqual({ command: '/opt/pnpm/pnpm', prefixArgs: [] });
  });
});

describe('verify.mjs as a process', () => {
  const emptyDir = mkdtempSync(path.join(tmpdir(), 'spareon-nopath-'));
  afterAll(() => {
    rmSync(emptyDir, { recursive: true, force: true });
  });

  const run = (args: string[], env: Record<string, string>) =>
    spawnSync(process.execPath, [verifyScript, ...args], {
      cwd: repoRoot,
      env: { SystemRoot: process.env['SystemRoot'] ?? '', ...env },
      encoding: 'utf8',
      shell: false,
    });

  it('exits 2 on an unknown argument', () => {
    expect(run(['--nope'], { PATH: emptyDir }).status).toBe(2);
  });

  it('exits 1 when only Go was requested and Go is not on PATH (nothing verified)', () => {
    const r = run(['--only=go'], { PATH: emptyDir });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/nothing was verified/);
    expect(r.stdout).toMatch(/go:test\s+SKIPPED/);
  });

  it('exits 1 when Go is not on PATH and REQUIRE_GO=1', () => {
    const r = run(['--only=go'], { PATH: emptyDir, REQUIRE_GO: '1' });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/go:test\s+FAIL/);
  });
});

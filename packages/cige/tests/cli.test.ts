import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { main, type CliIo } from '../src/cli.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CASE = {
  id: 'checkout',
  Context: { environment: 'staging' },
  Intent: 'A shopper can pay by {method}',
  Execution: ['pay by {method}'],
  Variants: [{ id: 'card', params: { method: 'card' } }],
};

// Plain JavaScript, so the test loads it without a TypeScript step; `reset` leaves a mark the test reads.
const CONFIG = `export default {
  cases: 'tests/cige/*.cige.json',
  environments: {
    staging: { config: 'e2e.staging.config.ts', reset() { globalThis.cigeResets = (globalThis.cigeResets ?? 0) + 1; } },
    bare: {},
  },
};
`;

function project(withConfig = true): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cige-cli-'));
  dirs.push(dir);
  // Where the default glob looks, so the commands that need no config find it too.
  mkdirSync(path.join(dir, 'tests', 'cige'), { recursive: true });
  writeFileSync(path.join(dir, 'tests', 'cige', 'checkout.cige.json'), JSON.stringify(CASE));
  if (withConfig) writeFileSync(path.join(dir, 'cige.config.mjs'), CONFIG);
  return dir;
}

function io(cwd: string): CliIo & { out: string; err: string; runs: { args: readonly string[]; cwd: string }[] } {
  const state = {
    cwd,
    out: '',
    err: '',
    runs: [] as { args: readonly string[]; cwd: string }[],
    stdout: (text: string) => void (state.out += text),
    stderr: (text: string) => void (state.err += text),
    runE2e: async (args: readonly string[], at: string) => {
      state.runs.push({ args, cwd: at });
      return 1;
    },
  };
  return state;
}

describe('e2e-cige', () => {
  it('prints usage, and exits 2 on no command or an unknown one', async () => {
    const help = io(project());
    expect(await main(['--help'], help)).toBe(0);
    expect(help.out).toContain('Usage: npx e2e-cige');
    expect(await main([], io(project()))).toBe(2);
    const unknown = io(project());
    expect(await main(['heal'], unknown)).toBe(2);
    expect(unknown.err).toContain('unknown command "heal"');
  });

  it('replays one variant in its environment: reset, then e2e with its config, and its exit code', async () => {
    const dir = project();
    const state = io(dir);
    const before = (globalThis as { cigeResets?: number }).cigeResets ?? 0;
    expect(await main(['replay', 'checkout', '--variant', 'card', '--', '--target', 'web'], state)).toBe(1);
    expect((globalThis as { cigeResets?: number }).cigeResets).toBe(before + 1);
    expect(state.runs).toEqual([
      { args: ['run', '--config', 'e2e.staging.config.ts', '--tag', 'cige:checkout/card', '--no-cache', '--target', 'web'], cwd: dir },
    ]);
  });

  it('refuses a replay that names no variant of a case that has them, or an undeclared environment', async () => {
    const state = io(project());
    expect(await main(['replay', 'checkout'], state)).toBe(2);
    expect(state.err).toContain('pass --variant card');
    const env = io(project());
    expect(await main(['replay', 'checkout', '--variant', 'card', '--env', 'prod'], env)).toBe(2);
    expect(env.err).toContain('no environment "prod"; known: staging, bare');
    expect(env.runs).toEqual([]);
  });

  it('replays without a config, treating the environment as prose', async () => {
    const dir = project(false);
    const state = io(dir);
    await main(['replay', 'checkout', '--variant', 'card'], state);
    expect(state.runs[0]?.args).toEqual(['run', '--tag', 'cige:checkout/card', '--no-cache']);
  });

  it('needs a config for env, and an action the environment has', async () => {
    const none = io(project(false));
    expect(await main(['env', 'reset', 'staging'], none)).toBe(2);
    expect(none.err).toContain('no CIGE config');
    const bare = io(project());
    expect(await main(['env', 'reset', 'bare'], bare)).toBe(2);
    expect(bare.err).toContain('environment "bare" has no reset action');
    const bad = io(project());
    expect(await main(['env', 'restart', 'staging'], bad)).toBe(2);
    const ok = io(project());
    expect(await main(['env', 'reset', 'staging'], ok)).toBe(0);
    expect(ok.out).toBe('reset staging: done\n');
  });

  it('writes the refs pointers even with no resolvers', async () => {
    const dir = project(false);
    writeFileSync(path.join(dir, 'tests', 'cige', 'checkout.cige.json'), JSON.stringify({ ...CASE, Context: { buildRef: 'releases/{build}.md' } }));
    const state = io(dir);
    expect(await main(['refs', 'checkout', '--variant', 'card', '--build', '1.2.3'], state)).toBe(0);
    expect(state.out.trim()).toBe(path.join('.e2e', 'cige', 'checkout.card.refs'));
    const index = JSON.parse(readFileSync(path.join(dir, '.e2e', 'cige', 'checkout.card.refs', 'index.json'), 'utf8')) as unknown;
    expect(index).toEqual({ testId: 'checkout', variant: 'card', build: '1.2.3', refs: { build: { pointer: 'releases/1.2.3.md' } } });
  });
});

describe('e2e-cige check', () => {
  it('lists what each case lacks for classification and replay, and fails on a gap', async () => {
    const dir = project();
    writeFileSync(
      path.join(dir, 'tests', 'cige', 'ready.cige.json'),
      JSON.stringify({ id: 'ready', Context: { specRef: 'docs/specs/pay.md', buildRef: 'CHANGELOG.md' }, Intent: 'A ready case', Execution: ['x'] }),
    );
    writeFileSync(
      path.join(dir, 'tests', 'cige', 'bare.cige.json'),
      JSON.stringify({ id: 'bare', Context: { environment: 'bare', specRef: 'releases/{build}/spec.md' }, Intent: 'A bare case', Execution: ['x'] }),
    );
    const state = io(dir);
    expect(await main(['check'], state)).toBe(1);
    expect(state.out).toContain('tests/cige/bare.cige.json (bare)\n  no-build-ref:');
    expect(state.out).toContain('  build-unset: a ref uses {build}, but the config sets no build');
    expect(state.out).toContain('  environment-no-reset: environment "bare" has no reset action');
    expect(state.out).toContain('(checkout)\n  no-spec-ref:');
    expect(state.out).not.toContain('(ready)');
    expect(state.out).toContain('2 of 3 CIGE cases have gaps.');
    const json = io(dir);
    expect(await main(['check', '--json', '--warn', '--build', '1.0.0'], json)).toBe(0);
    const report = JSON.parse(json.out) as { cases: number; ready: number; results: { id: string; gaps: { kind: string }[] }[] };
    expect(report).toMatchObject({ cases: 3, ready: 1 });
    expect(report.results.find((result) => result.id === 'bare')?.gaps.map((gap) => gap.kind)).toEqual(['no-build-ref', 'environment-no-reset']);
  });

  it('flags an environment the config does not declare', async () => {
    const state = io(project(false));
    expect(await main(['check'], state)).toBe(1);
    expect(state.out).toContain('environment-undeclared: environment "staging" is not in the config\'s environments');
  });
});

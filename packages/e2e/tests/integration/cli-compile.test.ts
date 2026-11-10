/**
 * `e2e compile` end to end through the built CLI, on the fixture app with an
 * executor that taps without a model: a step with no recording is recorded by
 * running its test, kept as an `agent.act()` while its target has no test id,
 * compiled with `--loose` into lines that pass with the agent forbidden and
 * the cache off once a run passed on them, and reverted to the original
 * source, whose recording still replays.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { createProject, type FixtureProject } from '../helpers/run-project.ts';

const CLI = fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url));

const SUITE = `import { test, expect } from 'e2e';

test('increments twice', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('increment the counter twice');
  await expect(screen.getByRole('status')).toHaveText('2');
});
`;

/**
 * Taps Increment twice with no model. With `E2E_FORBID_AGENT=1` it fails any
 * step handed to it, so a run that passes then ran no agent step live.
 */
const CONFIG = String.raw`import { web } from '@e2e-dev/web';

const executor = {
  name: 'two-taps',
  version: 'test',
  async runStep(context) {
    if (process.env.E2E_FORBID_AGENT === '1') return { status: 'failed', summary: 'the agent ran' };
    let observation = await context.observe();
    for (let tap = 0; tap < 2; tap += 1) {
      const line = observation.text.split('\n').find((candidate) => /button "Increment"/.test(candidate)) ?? '';
      await context.actions.tap({ id: /#(\S+)/.exec(line)?.[1] ?? '' });
      observation = await context.observe();
    }
    return { status: 'passed', summary: 'the counter shows 2' };
  },
};

export default {
  tests: 'tests/**/*.e2e.ts',
  targets: [{ name: 'web', engine: web(), app: { url: process.env.APP_URL } }],
  agents: { default: { executor } },
  cache: 'read-write',
  workers: 1,
};
`;

describe('e2e compile', () => {
  let app: FixtureApp;
  let project: FixtureProject;

  /**
   * Runs one CLI command in the project, outside CI, against the fixture app.
   * Asynchronous: the fixture app serves from this process, so a blocking
   * spawn would leave it unable to answer the run it waits on.
   */
  async function cli(args: readonly string[], env: Record<string, string> = {}): Promise<{ exitCode: number | null; output: string }> {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: project.dir,
      env: { ...process.env, CI: '', NO_COLOR: '1', APP_URL: app.url, ...env },
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    const [exitCode] = (await once(child, 'close')) as [number | null];
    return { exitCode, output };
  }

  const suite = (): string => readFileSync(path.join(project.dir, 'tests', 'act.e2e.ts'), 'utf8');

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ 'e2e.config.ts': CONFIG, 'tests/act.e2e.ts': SUITE });
  });

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('records a step with no recording, then keeps it while its target has no test id', async () => {
    const compiled = await cli(['compile', 'tests/act.e2e.ts', '--write']);
    expect(compiled.exitCode, compiled.output).toBe(0);
    expect(compiled.output).toContain('Recording 1 test(s) with no recording yet: e2e run tests/act.e2e.ts:3');
    expect(compiled.output).toContain('[unverified-locator] no test id on button "Increment"');
    expect(compiled.output).toContain('0 step(s) compiled, 1 left to the agent');
    expect(readdirSync(path.join(project.dir, '.e2e', 'cache')).filter((name) => name.endsWith('.json'))).toHaveLength(1);
    expect(suite()).toBe(SUITE);
  }, 180_000);

  it('reports the step, its code, and the test id that would unlock it', async () => {
    const status = await cli(['compile', 'status', '--json']);
    expect(status.exitCode, status.output).toBe(0);
    const report = JSON.parse(status.output) as {
      summary: { steps: number; compiles: number; byCode: Record<string, number> };
      testIds: { target: string; unlocks: number }[];
    };
    expect(report.summary).toMatchObject({ steps: 1, compiles: 0, byCode: { 'unverified-locator': 1 } });
    expect(report.testIds).toEqual([{ target: 'button "Increment"', unlocks: 1 }]);
  });

  it('fails with the agent forbidden while the step is an agent.act() and the cache is off', async () => {
    const forbidden = await cli(['run', '--no-cache'], { E2E_FORBID_AGENT: '1' });
    expect(forbidden.exitCode, forbidden.output).toBe(1);
  }, 120_000);

  it('compiles the recording with --loose, verifies it on a run, and passes with no agent and no cache', async () => {
    const compiled = await cli(['compile', 'tests/act.e2e.ts', '--loose', '--write', '--no-run', '--verify']);
    expect(compiled.exitCode, compiled.output).toBe(0);
    expect(compiled.output).toContain('increments twice passed with its compiled lines');
    expect(compiled.output).toContain('1 step(s) compiled, 0 left to the agent');
    const source = suite();
    expect(source).toContain(`  /**\n   * @compiled agent.act("increment the counter twice")\n   * @from "await agent.act('increment the counter twice');"\n`);
    expect(source).toMatch(/ \* @recording [0-9a-f]{12}\n/u);
    expect(source).toMatch(/ \* @verifiedAt \d{4}-\d{2}-\d{2}\n {3}\*\/\n/u);
    // A run passed on the lines, so none is still marked a guess.
    expect(source.match(/^ {2}await screen\.getByRole\("button", "Increment"\)\.tap\(\);$/gmu)).toHaveLength(2);
    expect(source).toContain('  /** @end compiled */\n');
    expect(source).not.toMatch(/^\s*await agent\.act/mu);

    const ran = await cli(['run', '--no-cache'], { E2E_FORBID_AGENT: '1' });
    expect(ran.exitCode, ran.output).toBe(0);

    const status = await cli(['compile', 'status', '--json']);
    expect(JSON.parse(status.output)).toMatchObject({ summary: { steps: 1, compiled: 1, stale: 0 } });
  }, 180_000);

  it('reverts the block to the call it was compiled from, whose recording still replays', async () => {
    const preview = await cli(['compile', 'revert', 'tests/act.e2e.ts:5']);
    expect(preview.output).toContain('1 block(s) would revert');
    expect(suite()).not.toBe(SUITE);

    const reverted = await cli(['compile', 'revert', 'tests/act.e2e.ts:3', '--write']);
    expect(reverted.exitCode, reverted.output).toBe(0);
    expect(suite()).toBe(SUITE);

    const replayed = await cli(['run'], { E2E_FORBID_AGENT: '1' });
    expect(replayed.exitCode, replayed.output).toBe(0);
  }, 180_000);

  it('puts a block back when its verification run does not pass', async () => {
    // The recording now taps a button the page does not have: its lines compile, and fail on the live app.
    const directory = path.join(project.dir, '.e2e', 'cache');
    for (const name of readdirSync(directory).filter((file) => file.endsWith('.json'))) {
      const file = path.join(directory, name);
      writeFileSync(file, readFileSync(file, 'utf8').replaceAll('"Increment"', '"Decrement"'));
    }
    const compiled = await cli(['compile', 'tests/act.e2e.ts', '--loose', '--write', '--no-run', '--verify']);
    expect(compiled.exitCode, compiled.output).toBe(0);
    expect(compiled.output).toContain('[verify-failed] the test failed with its compiled lines; 1 block(s) are agent.act() again');
    expect(compiled.output).toContain('0 step(s) compiled, 1 left to the agent');
    expect(suite()).toBe(SUITE);
  }, 180_000);
});

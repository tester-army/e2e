import { parseDocument } from 'yaml';
/** Real runner coverage for one cache file per test and unchanged act-call miss semantics. */
import { readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emitReplayYaml, readReplayYaml } from '../../src/cache/yaml.ts';
import { cacheFileName } from '../../src/cache/file-name.ts';
import type { StepExecutor } from '../../src/agent/executor.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { nodeIdFor } from '../helpers/fake-loop-model.ts';
import { createProject, runExisting, resultByTitle, type FixtureProject } from '../helpers/run-project.ts';

const TEST_ID = 'tests/flow.e2e.ts::two%20acts';
/** Different labels and repeated labels exercise both the signature and occurrence in a key. */
function suite(labels = ['first increment', 'second increment', 'first increment'], title = 'two acts'): string {
  return `import { test, expect } from 'e2e';
  test(${JSON.stringify(title)}, async ({ app, agent, screen }) => {
    await app.open();
    ${labels.map((label, i) => `await agent.act(${JSON.stringify(label)}); await expect(screen.getByRole('status')).toHaveText('${i + 1}');`).join('\n')}
  });`;
}

let app: FixtureApp;
const projects: FixtureProject[] = [];
beforeAll(async () => { app = await startFixtureApp(); });
afterAll(async () => { for (const project of projects) project.cleanup(); await app.close(); });

/** A deterministic executor proves exactly when the runner falls through to the agent. */
function fixture() {
  const project = createProject({ 'tests/flow.e2e.ts': suite() });
  projects.push(project);
  const calls: string[] = [];
  const executor: StepExecutor = {
    name: 'one-tap', version: '1',
    async runStep(context) {
      calls.push(context.step.instruction);
      const observation = await context.observe();
      await context.actions.tap({ id: nodeIdFor(observation.text, /button "Increment"/) });
      return { status: 'passed', summary: 'Incremented once' };
    },
  };
  const file = path.join(project.dir, '.e2e/cache', cacheFileName(TEST_ID));
  const run = (strict = false) => runExisting(project, {
    appUrl: app.url,
    config: { tests: 'tests/**/*.e2e.ts', agents: { default: { executor } }, cache: { mode: 'read-write', strict }, retries: 0 },
  });
  return { project, calls, file, run, read: () => readReplayYaml(readFileSync(file, 'utf8')) };
}

describe('per-test file discovery and act matching', () => {
  it('finds the expected readable slug in the cache folder and replays three keyed calls in order', async () => {
    const f = fixture();
    const first = await f.run();
    expect(first.exitCode).toBe(0);
    expect(f.calls).toEqual(['first increment', 'second increment', 'first increment']);
    expect(readdirSync(path.dirname(f.file))).toEqual([cacheFileName(TEST_ID)]);
    const recording = f.read();
    expect(path.basename(f.file)).toBe('flow-two-acts.yml');
    expect(recording.testId).toBe(TEST_ID);
    expect(recording.steps.map((step) => step.trace.instruction)).toEqual(['first increment', 'second increment', 'first increment']);
    expect(recording.steps.map((step) => step.order)).toEqual([0, 1, 2]);
    expect(new Set(recording.steps.map((step) => step.key)).size).toBe(3);
    const before = readFileSync(f.file, 'utf8');
    expect(parseDocument(before).toJS().recordedWith).toEqual({
      engine: 1, platform: 'web', app: expect.stringMatching(/^[a-f0-9]{64}$/u), contextDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    f.calls.length = 0;
    const second = await f.run();
    expect(second.exitCode).toBe(0);
    expect(f.calls).toEqual([]);
    expect(resultByTitle(second, 'two acts').attempts[0]!.steps.filter((step) => step.api === 'agent.act').map((step) => step.cache?.mode)).toEqual(['self-finalized', 'self-finalized', 'self-finalized']);
    expect(readFileSync(f.file, 'utf8')).toBe(before);
  });

  it.each([false, true])('missing file invokes the agent, strict=%s', async (strict) => {
    const f = fixture();
    expect((await f.run()).exitCode).toBe(0);
    unlinkSync(f.file);
    f.calls.length = 0;
    expect((await f.run(strict)).exitCode).toBe(0);
    expect(f.calls).toHaveLength(3);
    expect(readdirSync(path.dirname(f.file))).toHaveLength(strict ? 0 : 1);
  });

  it.each([false, true])('a missing act invokes only that call, strict=%s', async (strict) => {
    const f = fixture();
    expect((await f.run()).exitCode).toBe(0);
    const recording = f.read();
    writeFileSync(f.file, emitReplayYaml({ ...recording, steps: recording.steps.filter((step) => step.order !== 1) }));
    const before = readFileSync(f.file, 'utf8');
    f.calls.length = 0;
    expect((await f.run(strict)).exitCode).toBe(0);
    expect(f.calls).toEqual(['second increment']);
    expect(f.read().steps).toHaveLength(strict ? 2 : 3);
    if (strict) expect(readFileSync(f.file, 'utf8')).toBe(before);
  });

  it.each([false, true])('a stale target repairs normally and fails without model use in strict mode, strict=%s', async (strict) => {
    const f = fixture();
    expect((await f.run()).exitCode).toBe(0);
    const recording = f.read();
    writeFileSync(f.file, emitReplayYaml({ ...recording, steps: recording.steps.map((step) => step.order !== 1 ? step : {
      ...step, trace: { ...step.trace, actions: [{ name: 'tap', summary: 'stale target', target: { role: 'button', name: 'Removed button' } }] },
    }) }));
    const before = readFileSync(f.file, 'utf8');
    f.calls.length = 0;
    const outcome = await f.run(strict);
    expect(outcome.exitCode).toBe(strict ? 2 : 0);
    expect(f.calls).toEqual(strict ? [] : ['second increment']);
    if (strict) {
      expect(resultByTitle(outcome, 'two acts').attempts[0]!.error?.code).toBe('REPLAY_STALE');
      expect(readFileSync(f.file, 'utf8')).toBe(before);
    } else expect(f.read().steps[1]!.trace.actions[0]).toMatchObject({ target: { name: 'Increment' } });
  });


  it.each([false, true])('invalid YAML repairs normally and fails closed in strict mode, strict=%s', async (strict) => {
    const f = fixture();
    expect((await f.run()).exitCode).toBe(0);
    writeFileSync(f.file, 'test: *forbidden');
    f.calls.length = 0;
    const result = await f.run(strict);
    expect(result.exitCode).toBe(strict ? 2 : 0);
    expect(f.calls).toHaveLength(strict ? 0 : 3);
    if (strict) {
      expect(resultByTitle(result, 'two acts').attempts[0]!.error?.code).toBe('REPLAY_STALE');
      expect(readFileSync(f.file, 'utf8')).toBe('test: *forbidden');
    } else expect(f.read().steps).toHaveLength(3);
  });

  it('replaces changed steps and prunes removed steps after a successful body', async () => {
    const f = fixture();
    expect((await f.run()).exitCode).toBe(0);
    const oldKeys = f.read().steps.map((step) => step.key);
    writeFileSync(path.join(f.project.dir, 'tests/flow.e2e.ts'), suite(['first increment', 'replacement increment']));
    f.calls.length = 0;
    expect((await f.run()).exitCode).toBe(0);
    expect(f.calls).toEqual(['replacement increment']);
    const keys = f.read().steps.map((step) => step.key);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(oldKeys[0]);
    expect(keys).not.toContain(oldKeys[1]);
    expect(keys).not.toContain(oldKeys[2]);
  });

  it('renaming a test creates its new slug file and removes the old recording', async () => {
    const f = fixture();
    expect((await f.run()).exitCode).toBe(0);
    writeFileSync(path.join(f.project.dir, 'tests/flow.e2e.ts'), suite(undefined, 'renamed'));
    expect((await f.run()).exitCode).toBe(0);
    expect(readdirSync(path.dirname(f.file))).toEqual([cacheFileName('tests/flow.e2e.ts::renamed')]);
  });
});

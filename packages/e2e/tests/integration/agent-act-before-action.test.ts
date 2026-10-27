/** Before-dispatch observations through the built-in loop, the real engine, and replay. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { installFakeLoopModel, loopCalls, nodeIdFor } from '../helpers/fake-loop-model.ts';
import { createProject, resultByTitle, runExisting, runProject, type RunOutcome } from '../helpers/run-project.ts';
import { readEntries } from '../helpers/trace-cache.ts';
import type { StepExecutor } from '../../src/agent/executor.ts';

const TITLE = 'captures before incrementing';
const SUITE = `import { test, expect } from 'e2e';
test(${JSON.stringify(TITLE)}, async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('increment twice', {
    onBeforeAction: async ({ index, source }) => {
      await expect(screen.getByRole('status')).toHaveText(String(index - 1));
      await app.screenshot(\`before \${index} \${source}\`);
    },
    onAction: async ({ index }) => {
      await expect(screen.getByRole('status')).toHaveText(String(index));
    },
  });
  await expect(screen.getByRole('status')).toHaveText('2');
});
`;

/** Exercises the production agent loop, without a live provider. */
function twoTaps() {
  return installFakeLoopModel(call => call.turn <= 2
    ? [{ toolName: 'tap', input: { target: nodeIdFor(call.prompt, /button "Increment"/) } }]
    : [{ toolName: 'complete_step', input: { status: 'passed', summary: 'incremented twice' } }]);
}

function labels(outcome: RunOutcome, title = TITLE): string[] {
  return resultByTitle(outcome, title).attempts[0]!.steps
    .filter(step => step.api === 'app.screenshot').map(step => step.label);
}

describe('agent.act onBeforeAction', () => {
  let app: FixtureApp;
  beforeAll(async () => { app = await startFixtureApp(); });
  afterAll(async () => { await app?.close(); });

  it('captures the starting screens in the built-in loop and verified replay, with no after-images', async () => {
    const project = createProject({ 'tests/before.e2e.ts': SUITE });
    const options = () => ({ appUrl: app.url, config: { agents: { default: { model: twoTaps() } }, cache: 'read-write' as const } });
    try {
      const recorded = await runExisting(project, options());
      expect(resultByTitle(recorded, TITLE).status).toBe('passed');
      expect(labels(recorded)).toEqual(['before 1 model', 'before 2 model']);
      expect(readEntries(project)).toHaveLength(1);
      const replayed = await runExisting(project, options());
      expect(resultByTitle(replayed, TITLE).status).toBe('passed');
      expect(labels(replayed)).toEqual(['before 1 replay', 'before 2 replay']);
      expect(loopCalls).toHaveLength(0);
    } finally { project.cleanup(); }
  }, 120_000);

  it('stops before mutation when the observer throws', async () => {
    const suite = `import { test, expect } from 'e2e';
test('observer fails', async ({ app, agent, screen }) => {
  await app.open();
  let failure;
  try {
    await agent.act('increment twice', { onBeforeAction: () => { throw new Error('before broke'); } });
  } catch (error) { failure = error; }
  await expect(screen.getByRole('status')).toHaveText('0');
  throw failure;
});`;
    const { outcome, project } = await runProject({ 'tests/before.e2e.ts': suite }, { appUrl: app.url, config: { agents: { default: { model: twoTaps() } } } });
    try {
      const attempt = resultByTitle(outcome, 'observer fails').attempts[0]!;
      expect(attempt.error).toMatchObject({ code: 'ACTION_FAILED', message: expect.stringContaining('onBeforeAction failed: before broke') });
      expect(attempt.steps.some(step => step.api === 'expect.toHaveText' && step.status === 'passed')).toBe(true);
      expect(attempt.steps.find(step => step.api === 'agent.act')?.metrics?.actionSteps).toBe(1);
    } finally { project.cleanup(); }
  });

  it('preserves a verified recording when a replay observer fails before dispatch', async () => {
    const project = createProject({ 'tests/before.e2e.ts': SUITE });
    const options = () => ({ appUrl: app.url, config: { agents: { default: { model: twoTaps() } }, cache: 'read-write' as const } });
    try {
      const recorded = await runExisting(project, options());
      expect(resultByTitle(recorded, TITLE).status).toBe('passed');
      const files = readEntries(project).map(({ file }) => [file, readFileSync(file, 'utf8')] as const);
      expect(files).toHaveLength(1);
      writeFileSync(path.join(project.dir, 'tests/before.e2e.ts'), SUITE.replace(
        "onBeforeAction: async ({ index, source }) => {",
        "onBeforeAction: async ({ index, source }) => { if (source === 'replay') throw new Error('replay observer broke');",
      ));
      const replayed = await runExisting(project, options());
      expect(resultByTitle(replayed, TITLE).attempts[0]!.error?.message).toContain('onBeforeAction failed: replay observer broke');
      expect(loopCalls).toHaveLength(0);
      expect(readEntries(project).map(({ file }) => [file, readFileSync(file, 'utf8')] as const)).toEqual(files);
    } finally { project.cleanup(); }
  }, 120_000);

  it('does not confirm a recording through checks inside the observer', async () => {
    const suite = SUITE.replace("  await expect(screen.getByRole('status')).toHaveText('2');", '');
    const { outcome, project } = await runProject({ 'tests/before.e2e.ts': suite }, { appUrl: app.url, config: { agents: { default: { model: twoTaps() } }, cache: 'read-write' } });
    try {
      expect(resultByTitle(outcome, TITLE).status).toBe('passed');
      expect(readEntries(project)).toEqual([]);
    } finally { project.cleanup(); }
  });

  it('observes mutating project tools, not read-only tools', async () => {
    const executor: StepExecutor = { name: 'tool-fixture', async runStep(context) {
      await context.budgets.runTool({ name: 'read', mutates: false }, async () => undefined);
      await context.budgets.runTool({ name: 'write', mutates: true }, async () => undefined);
      return { status: 'passed', summary: 'ran tools' };
    } };
    const suite = `import { test } from 'e2e';
test('tool observer', async ({ app, agent }) => {
  await app.open();
  await agent.act('run tools', { onBeforeAction: async ({ index, source }) => { await app.screenshot(\`before \${index} \${source}\`); } });
});`;
    const { outcome, project } = await runProject({ 'tests/before.e2e.ts': suite }, { appUrl: app.url, config: { agents: { default: { executor } } } });
    try {
      expect(resultByTitle(outcome, 'tool observer').status).toBe('passed');
      expect(labels(outcome, 'tool observer')).toEqual(['before 1 model']);
    } finally { project.cleanup(); }
  });

  it('records a failed dispatch attempt without a completion notification', async () => {
    const model = installFakeLoopModel(call => call.turn === 1
      ? [{ toolName: 'tap', input: { target: 'n99999' } }]
      : [{ toolName: 'complete_step', input: { status: 'passed', summary: 'observed the refused attempt' } }]);
    const suite = `import { test, expect } from 'e2e';
test('failed dispatch', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('attempt a missing target', {
    onBeforeAction: async ({ index }) => { await app.screenshot(\`before \${index}\`); },
    onAction: () => { throw new Error('must not complete'); },
  });
  await expect(screen.getByRole('status')).toHaveText('0');
});`;
    const { outcome, project } = await runProject({ 'tests/before.e2e.ts': suite }, { appUrl: app.url, config: { agents: { default: { model } } } });
    try {
      expect(resultByTitle(outcome, 'failed dispatch').status).toBe('passed');
      expect(labels(outcome, 'failed dispatch')).toEqual(['before 1']);
    } finally { project.cleanup(); }
  });
});

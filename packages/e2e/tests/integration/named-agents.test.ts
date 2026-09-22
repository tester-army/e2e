/** `agents` by name: `--agent` runs the suite with another configured brain, and the run says so. */

import { stripVTControlCharacters } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StepExecutor } from '../../src/agent/executor.ts';
import type { RunEvent } from '../../src/run/events.ts';
import { judgment } from '../helpers/fake-model.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { createProject, runExisting, type FixtureProject } from '../helpers/run-project.ts';
import { createScriptedInstance, scriptedResult } from '../helpers/scripted-model.ts';

const SUITE = `
import { test } from '@e2edev/web';
import { expect } from 'e2e';

test('asks the agent', async ({ app, agent }) => {
  await app.open();
  const result = await agent.act('do the thing');
  expect(result.summary).toContain('done by');
});
`;

const PINNED_SUITE = `
import { test } from '@e2edev/web';
import { expect } from 'e2e';

test.describe('as the buyer', { agent: 'buyer' }, () => {
  test('buyer browses', async ({ app, agent }) => {
    await app.open();
    expect((await agent.act('browse')).summary).toBe('done by buyer-brain');
  });

  test.describe('refunds', { agent: 'admin' }, () => {
    test('admin refunds, buyer confirms', async ({ app, agent }) => {
      await app.open();
      expect((await agent.act('refund')).summary).toBe('done by admin-brain');
      expect((await agent.act('confirm', { agent: 'buyer' })).summary).toBe('done by buyer-brain');
      await agent.assert('the refund shows', { agent: 'buyer' });
    });
  });
});

test('unpinned follows the run', async ({ app, agent }) => {
  await app.open();
  expect((await agent.act('whatever')).summary).toContain('done by');
});

test('an unknown agent on a call fails that call', async ({ app, agent }) => {
  await app.open();
  await agent.act('x', { agent: 'nobody' });
});
`;

const PERSONA_SUITE = `
import { test } from '@e2edev/web';
import { expect } from 'e2e';

test.describe('checkout', { agent: ['buyer', 'admin'] }, () => {
  test('pays for one item', async ({ app, agent }) => {
    await app.open();
    expect((await agent.act('pay')).summary).toMatch(/^done by (buyer|admin)-brain$/);
  });
});

test('unpinned follows the run', async ({ app, agent }) => {
  await app.open();
  expect((await agent.act('whatever')).summary).toContain('done by');
});
`;

const TWO_MODELS_SUITE = `
import { test } from '@e2edev/web';

test('the default agent judges twice', async ({ app, agent }) => {
  await app.open();
  await agent.assert('ready');
  await agent.assert('still ready');
});

test.describe('as the buyer', { agent: 'buyer' }, () => {
  test('the buyer judges once', async ({ app, agent }) => {
    await app.open();
    await agent.assert('ready');
  });
});
`;

/** An executor that signs its verdict, so the report shows which one ran. */
function signing(name: string): StepExecutor {
  return { name, async runStep() { return { status: 'passed', summary: `done by ${name}` }; } };
}

/** A scripted model that holds every judgment, named so the AI row can tell it from another. */
function judging(provider: string, modelId: string) {
  return createScriptedInstance(provider, modelId, async () =>
    scriptedResult([{ type: 'text', text: JSON.stringify(judgment(true, 'ready')) }], 'stop'));
}

describe('named agents', () => {
  let app: FixtureApp;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ 'tests/agents.e2e.ts': SUITE });
  });

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('runs with agents.default, and with another agent when the run names it', async () => {
    const config = { tests: 'tests/**/*.e2e.ts', cache: 'off' as const, agents: { default: signing('house'), ux: signing('ux-review') } };
    const started: RunEvent[] = [];
    const byDefault = await runExisting(project, { appUrl: app.url, config, runOptions: { onEvent: (event) => { if (event.type === 'run-started') started.push(event); } } });
    expect(byDefault.status).toBe('passed');
    expect(stepSummary(byDefault)).toBe('done by house');
    expect(started[0]).not.toHaveProperty('agents');

    const byName = await runExisting(project, { appUrl: app.url, config, runOptions: { agent: 'ux', onEvent: (event) => { if (event.type === 'run-started') started.push(event); } } });
    expect(byName.status).toBe('passed');
    expect(stepSummary(byName)).toBe('done by ux-review');
    expect(started[1]).toMatchObject({ type: 'run-started', agents: ['ux'] });
  }, 120_000);

  it('pins suites and calls to agents, records each step\'s agent, and keeps pins under --agent', async () => {
    const pinned = createProject({ 'tests/pinned.e2e.ts': PINNED_SUITE });
    try {
      const config = {
        tests: 'tests/**/*.e2e.ts',
        cache: 'off' as const,
        agents: { default: signing('house'), buyer: signing('buyer-brain'), admin: signing('admin-brain'), thorough: signing('thorough-brain') },
      };
      const outcome = await runExisting(pinned, { appUrl: app.url, config, runOptions: { agent: 'thorough' } });
      const byTitle = Object.fromEntries(outcome.report.run.results.map((result) => [result.titlePath.at(-1), result]));

      // Pins hold under --agent; the unpinned test follows the run's agent.
      expect(byTitle['buyer browses']!.status).toBe('passed');
      expect(byTitle['admin refunds, buyer confirms']!.status).toBe('passed');
      expect(byTitle['unpinned follows the run']!.status).toBe('passed');
      expect(agentSteps(byTitle['unpinned follows the run']!)[0]?.explanation).toBe('done by thorough-brain');

      // Every agent step names the agent it ran with, per call.
      expect(agentSteps(byTitle['buyer browses']!).map((step) => step.agent)).toEqual(['buyer']);
      expect(agentSteps(byTitle['admin refunds, buyer confirms']!).map((step) => [step.api, step.agent])).toEqual([
        ['agent.act', 'admin'],
        ['agent.act', 'buyer'],
        ['agent.assert', 'buyer'],
      ]);
      expect(agentSteps(byTitle['unpinned follows the run']!).map((step) => step.agent)).toEqual(['thorough']);

      // A call naming nothing configured fails that call before its step opens.
      const unknown = byTitle['an unknown agent on a call fails that call']!;
      expect(unknown.status).toBe('failed');
      expect(unknown.attempts[0]!.error).toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(unknown.attempts[0]!.error?.message).toMatch(/unknown agent "nobody"; configured: default, buyer, admin, thorough/);
      expect(agentSteps(unknown)).toHaveLength(0);
      expect(outcome.exitCode).toBe(1);
    } finally {
      pinned.cleanup();
    }
  }, 120_000);

  it('runs a test once per pinned agent, with its own result and steps, and --agent narrows the pin or fans unpinned tests out', async () => {
    const personas = createProject({ 'tests/personas.e2e.ts': PERSONA_SUITE });
    try {
      const config = {
        tests: 'tests/**/*.e2e.ts',
        cache: 'off' as const,
        agents: { default: signing('house'), buyer: signing('buyer-brain'), admin: signing('admin-brain'), thorough: signing('thorough-brain') },
      };
      const summarize = (outcome: Awaited<ReturnType<typeof runExisting>>) =>
        outcome.report.run.results.map((result) => [result.titlePath.at(-1), result.agent, result.status, agentSteps(result)[0]?.explanation]);

      // No flag: the pinned test runs as each persona, the unpinned one as default.
      const started: RunEvent[] = [];
      const sweep = await runExisting(personas, { appUrl: app.url, config, runOptions: { onEvent: (event) => { if (event.type === 'run-started') started.push(event); } } });
      expect(sweep.status).toBe('passed');
      expect(summarize(sweep)).toEqual([
        ['pays for one item', 'buyer', 'passed', 'done by buyer-brain'],
        ['pays for one item', 'admin', 'passed', 'done by admin-brain'],
        ['unpinned follows the run', 'default', 'passed', 'done by house'],
      ]);
      expect(new Set(sweep.report.run.results.map((result) => result.id)).size).toBe(3);
      expect(started[0]).not.toHaveProperty('agents');

      // --agent admin,thorough: the pin narrows to admin; the unpinned test runs once per flag name.
      const narrowed = await runExisting(personas, { appUrl: app.url, config, runOptions: { agent: ['admin', 'thorough'], onEvent: (event) => { if (event.type === 'run-started') started.push(event); } } });
      expect(narrowed.status).toBe('passed');
      expect(summarize(narrowed)).toEqual([
        ['pays for one item', 'admin', 'passed', 'done by admin-brain'],
        ['unpinned follows the run', 'admin', 'passed', 'done by admin-brain'],
        ['unpinned follows the run', 'thorough', 'passed', 'done by thorough-brain'],
      ]);
      expect(started[1]).toMatchObject({ type: 'run-started', agents: ['admin', 'thorough'] });
      expect(started[1]).not.toHaveProperty('model');
    } finally {
      personas.cleanup();
    }
  }, 120_000);

  it('names each agent’s model with its call count on the AI row when two agents answered on two models', async () => {
    const twoModels = createProject({ 'tests/models.e2e.ts': TWO_MODELS_SUITE });
    const written: string[] = [];
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      const outcome = await runExisting(twoModels, {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          cache: 'off',
          agents: { default: { model: judging('fake-loop', 'scripted-loop') }, buyer: { model: judging('typesafe-ai', 'jev') } },
        },
        runOptions: { quiet: false },
      });
      stdoutWrite.mockRestore();
      expect(outcome.status).toBe('passed');
      const printed = stripVTControlCharacters(written.join(''));
      // The header names the configuration; the AI row names what answered.
      expect(printed).toContain('model fake-loop/scripted-loop\n');
      expect(printed).toContain('3 model calls · fake-loop/scripted-loop (2 calls) · typesafe-ai/jev (1 call)\n');
    } finally {
      stdoutWrite.mockRestore();
      twoModels.cleanup();
    }
  }, 120_000);

  it('fails collection when a test pins an agent the config does not define', async () => {
    const pinned = createProject({ 'tests/pinned.e2e.ts': PINNED_SUITE });
    try {
      const outcome = await runExisting(pinned, {
        appUrl: app.url,
        config: { tests: 'tests/**/*.e2e.ts', agents: { default: signing('house'), buyer: signing('buyer-brain') } },
      });
      expect(outcome.exitCode).toBe(2);
      expect(outcome.report.run.errors[0]?.message).toMatch(/names agent "admin", which agents does not define; configured: default, buyer/);
      expect(outcome.report.run.results).toHaveLength(0);
    } finally {
      pinned.cleanup();
    }
  }, 60_000);

  it('fails the run before any test when --agent names nothing configured', async () => {
    const outcome = await runExisting(project, {
      appUrl: app.url,
      config: { tests: 'tests/**/*.e2e.ts', agents: { default: signing('house') } },
      runOptions: { agent: 'nope' },
    });
    expect(outcome.exitCode).toBe(2);
    expect(outcome.report.run.errors[0]?.message).toMatch(/unknown agent "nope"; configured: default/);
    expect(outcome.report.run.results).toHaveLength(0);
  }, 60_000);
});

function agentSteps(result: Awaited<ReturnType<typeof runExisting>>['report']['run']['results'][number]) {
  return result.attempts[0]!.steps.filter((step) => step.kind === 'agent');
}

function stepSummary(outcome: Awaited<ReturnType<typeof runExisting>>): string | undefined {
  const step = outcome.report.run.results[0]?.attempts[0]?.steps.find((candidate) => candidate.api === 'agent.act');
  return step?.explanation;
}

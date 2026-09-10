/** `agents` by name: `--agent` runs the suite with another configured brain, and the run says so. */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StepExecutor } from '../../src/agent/executor.ts';
import type { RunEvent } from '../../src/run/events.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { createProject, runExisting, type FixtureProject } from '../helpers/run-project.ts';

const SUITE = `
import { test } from '@e2edev/playwright';
import { expect } from '@e2edev/e2e';

test('asks the agent', async ({ app, agent }) => {
  await app.open();
  const result = await agent.act('do the thing');
  expect(result.summary).toContain('done by');
});
`;

/** An executor that signs its verdict, so the report shows which one ran. */
function signing(name: string): StepExecutor {
  return { name, async runStep() { return { status: 'passed', summary: `done by ${name}` }; } };
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
    expect(started[0]).not.toHaveProperty('agent');

    const byName = await runExisting(project, { appUrl: app.url, config, runOptions: { agent: 'ux', onEvent: (event) => { if (event.type === 'run-started') started.push(event); } } });
    expect(byName.status).toBe('passed');
    expect(stepSummary(byName)).toBe('done by ux-review');
    expect(started[1]).toMatchObject({ type: 'run-started', agent: 'ux' });
  }, 120_000);

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

function stepSummary(outcome: Awaited<ReturnType<typeof runExisting>>): string | undefined {
  const step = outcome.report.run.results[0]?.attempts[0]?.steps.find((candidate) => candidate.api === 'agent.act');
  return step?.explanation;
}

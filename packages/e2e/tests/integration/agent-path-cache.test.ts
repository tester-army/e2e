/**
 * Path guidance integration coverage (spec 10-determinism.md "Path guidance").
 *
 * Runs the same project twice against one project directory so the second run
 * reads what the first wrote. Guidance is advisory, so the assertions are about
 * what reaches the prompt and what happens when the model ignores it — not about
 * saved model calls, which path guidance does not promise.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import {
  fakeCalls,
  installFakeModel,
  toolConclude,
  toolOnMatch,
  type FakeCall,
} from '../helpers/fake-model.ts';
import { assertValidCacheEntry } from '../helpers/cache-schema.ts';
import { createProject, runExisting, type FixtureProject } from '../helpers/run-project.ts';
import type { ReportStep } from '../../src/report/build.ts';

const SUITE = `import { test, expect } from 'e2e';

test('completes the onboarding', async ({ web, agent, screen }) => {
  await web.goto('/onboarding');
  await agent.act('complete the onboarding for Acme Inc');
  await expect(screen.getByLabel('Stage')).toHaveText('done');
});
`;

/** How the scripted planner should behave on a given run. */
type Mode = 'faithful' | 'divergeFirst' | 'divergeLate';

let mode: Mode = 'faithful';
/** Substitutions already made this run: each mode diverges exactly once. */
let substitutions = 0;

/**
 * Chooses the next onboarding action from what the screen shows.
 *
 * `divergeFirst` substitutes a different first action, before anything has
 * committed. `divergeLate` follows the path until the company name is typed —
 * a mutating action — then substitutes.
 */
function plan(call: FakeCall): unknown {
  if (call.observation.includes('You are all set')) {
    return toolConclude('the summary confirms Acme Inc');
  }
  if (call.observation.includes('Get started')) {
    if (mode === 'divergeFirst' && substitutions++ === 0) {
      return toolOnMatch(call, /heading "Onboarding"/, 'tap');
    }
    return toolOnMatch(call, /Get started/, 'tap');
  }
  if (call.observation.includes('Company name')) {
    const filled = /Company name.*value="Acme Inc"/.test(call.observation);
    if (!filled) return toolOnMatch(call, /Company name/, 'type', { value: 'Acme Inc' });
    if (mode === 'divergeLate' && substitutions++ === 0) {
      return toolOnMatch(call, /heading "Onboarding"/, 'tap');
    }
    return toolOnMatch(call, /Continue/, 'tap');
  }
  if (call.observation.includes('Email digest')) {
    const checked = /Email digest.*\[[^\]]*checked/.test(call.observation);
    return checked
      ? toolOnMatch(call, /Finish setup/, 'tap')
      : toolOnMatch(call, /Email digest/, 'tap');
  }
  return toolConclude('the screen matches no onboarding step', { status: 'failure' });
}

describe('agent.act path guidance', () => {
  let app: FixtureApp;

  beforeAll(async () => {
    app = await startFixtureApp();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  interface RunResult {
    readonly step: ReportStep;
    readonly guided: readonly string[];
    readonly passed: boolean;
    readonly project: FixtureProject;
  }

  async function runOnce(project: FixtureProject, behaviour: Mode): Promise<RunResult> {
    mode = behaviour;
    substitutions = 0;
    const model = installFakeModel(plan);
    const outcome = await runExisting(project, {
      appUrl: app.url,
      config: {
        tests: 'tests/**/*.e2e.ts',
        reporters: ['json'],
        agent: { model },
      },
    });
    const report = JSON.parse(
      readFileSync(path.join(project.dir, '.e2e', 'report.json'), 'utf8'),
    ) as { run: { results: { attempts: { steps: ReportStep[] }[] }[] } };
    const step = report.run.results
      .flatMap((result) => result.attempts)
      .flatMap((attempt) => attempt.steps)
      .find((candidate) => candidate.api === 'agent.act');
    if (step === undefined) throw new Error('no agent.act step in the report');
    return {
      step,
      guided: fakeCalls
        .map((call) => section(call.prompt, 'previous-successful-route'))
        .filter((text) => text !== ''),
      passed: outcome.status === 'passed',
      project,
    };
  }

  /** The cache entries this project wrote, validated against cache-1. */
  function entries(project: FixtureProject): unknown[] {
    const directory = path.join(project.dir, '.e2e', 'cache');
    const found: unknown[] = [];
    for (const name of readdirSafe(directory)) {
      const document = JSON.parse(readFileSync(path.join(directory, name), 'utf8'));
      assertValidCacheEntry(document);
      found.push(document);
    }
    return found;
  }

  it('records the path of a successful flow, and offers it on the next run', async () => {
    const project = createProject({ 'tests/act.e2e.ts': SUITE });
    try {
      const cold = await runOnce(project, 'faithful');
      expect(cold.passed).toBe(true);
      // Nothing to follow yet, so no route reaches the prompt.
      expect(cold.guided).toEqual([]);
      expect(cold.step.cache?.status).toBe('written');

      const written = entries(project);
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({ kind: 'path', payload: { type: 'path' } });
      const actions = (written[0] as { payload: { actions: unknown[] } }).payload.actions;
      // start, type, continue, digest, finish.
      expect(actions).toHaveLength(5);
      expect(actions[0]).toMatchObject({ kind: 'tap' });
      expect(actions[1]).toMatchObject({ kind: 'type', value: 'Acme Inc' });

      const warm = await runOnce(project, 'faithful');
      expect(warm.passed).toBe(true);
      expect(warm.step.cache?.status).toBe('hit');
      // Every round after the first is offered the action that worked there.
      expect(warm.guided.length).toBeGreaterThanOrEqual(4);
      expect(warm.guided[0]).toContain('the next step here was');
      expect(warm.guided[1]).toContain('Acme Inc');
    } finally {
      project.cleanup();
    }
  }, 180_000);

  it('discards guidance when the model diverges before anything commits', async () => {
    const project = createProject({ 'tests/act.e2e.ts': SUITE });
    try {
      await runOnce(project, 'faithful');
      const diverged = await runOnce(project, 'divergeFirst');
      // Tapping the heading changes nothing, so the flow still completes: the
      // guidance is simply dropped and the model reasons the rest out.
      expect(diverged.passed).toBe(true);
      // Offered once, at the round it diverged on, and never again: the path is
      // dropped for the rest of the invocation rather than re-suggested.
      expect(diverged.guided).toHaveLength(1);
      // The route it actually took supersedes the recorded one.
      expect(diverged.step.cache?.status).toBe('written');
      const actions = (entries(project)[0] as { payload: { actions: unknown[] } }).payload.actions;
      expect(actions).toHaveLength(6);
    } finally {
      project.cleanup();
    }
  }, 180_000);

  // Guidance is a suggestion, so declining it is never a failure — not even
  // mid-flow. Treating it as one made the cache turn a passing test red on any
  // page whose content moves between runs, which is the one thing a cache may
  // never do.
  it('still completes when it diverges partway through the flow', async () => {
    const project = createProject({ 'tests/act.e2e.ts': SUITE });
    try {
      await runOnce(project, 'faithful');
      const diverged = await runOnce(project, 'divergeLate');
      expect(diverged.passed).toBe(true);
      expect(diverged.step.error).toBeUndefined();
      // It followed the path up to the divergence, then stopped being offered it.
      expect(diverged.guided.length).toBeGreaterThanOrEqual(2);
    } finally {
      project.cleanup();
    }
  }, 180_000);

  it('writes nothing when the flow fails', async () => {
    const project = createProject({
      'tests/act.e2e.ts': `import { test } from 'e2e';

test('cannot finish', async ({ app, agent }) => {
  await app.open();
  await agent.act('complete the onboarding for Acme Inc');
});
`,
    });
    try {
      const failed = await runOnce(project, 'faithful');
      expect(failed.passed).toBe(false);
      expect(entries(project)).toEqual([]);
    } finally {
      project.cleanup();
    }
  }, 180_000);
});

function readdirSafe(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

/** Extracts one fenced prompt section. */
function section(prompt: string, name: string): string {
  const pattern = new RegExp(`<${name}[^>]*>\\n([\\s\\S]*?)\\n</${name}>`);
  return pattern.exec(prompt)?.[1] ?? '';
}

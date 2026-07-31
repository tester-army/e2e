/**
 * The two things that stop a planning flow from wandering off.
 *
 * Both exist because of the same observed failure: an `agent.act` that meets an
 * obstacle tries to recover by getting back to a screen it understands, and in
 * doing so destroys the state the rest of the test depends on. The runner is not
 * allowed to rely on the prompt for that — it withdraws the ability — and it has
 * to notice a flow going in circles rather than spending the whole budget on one.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import {
  fakeCalls,
  installFakeModel,
  toolCall,
  toolConclude,
  toolOnMatch,
  type FakeCall,
} from '../helpers/fake-model.ts';
import { createProject, runExisting, type FixtureProject } from '../helpers/run-project.ts';
import type { ReportStep } from '../../src/report/build.ts';

const SUITE = `import { test } from 'e2e';

test('plans through the onboarding', async ({ web, agent }) => {
  await web.goto('/onboarding');
  await agent.act('complete the onboarding for Acme Inc');
});
`;

describe('agent.act guardrails', () => {
  let app: FixtureApp;

  beforeAll(async () => {
    app = await startFixtureApp();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  async function run(
    project: FixtureProject,
    plan: (call: FakeCall) => unknown,
  ): Promise<{ readonly step: ReportStep; readonly passed: boolean }> {
    const model = installFakeModel(plan);
    const outcome = await runExisting(project, {
      appUrl: app.url,
      config: { tests: 'tests/**/*.e2e.ts', reporters: ['json'], agent: { model } },
    });
    const report = JSON.parse(
      readFileSync(path.join(project.dir, '.e2e', 'report.json'), 'utf8'),
    ) as { run: { results: { attempts: { steps: ReportStep[] }[] }[] } };
    const step = report.run.results
      .flatMap((result) => result.attempts)
      .flatMap((attempt) => attempt.steps)
      .find((candidate) => candidate.api === 'agent.act');
    if (step === undefined) throw new Error('no agent.act step in the report');
    return { step, passed: outcome.status === 'passed' };
  }

  /** Planning calls only, in the order they were made. */
  function planningCalls(): readonly FakeCall[] {
    return fakeCalls.filter((call) => call.schemaName === 'agent-tool-1');
  }

  // Before anything has committed, navigating is just getting to the right
  // screen. Afterwards it is the one action that cannot be taken back, so the
  // runner stops offering it rather than asking the model not to use it.
  it('withdraws navigation once an action has committed', async () => {
    const project = createProject({ 'tests/act.e2e.ts': SUITE });
    let refused = 0;
    try {
      const result = await run(project, (call) => {
        if (call.observation.includes('Get started')) {
          return toolOnMatch(call, /Get started/, 'tap');
        }
        // Committed something, then tries to start over. This is the shape of the
        // real failure: the flow is unsure, so it heads for a known screen.
        if (refused === 0) {
          refused += 1;
          return toolCall('navigate', { url: '/onboarding', explanation: 'start again' });
        }
        return toolConclude('cannot continue', { status: 'failure' });
      });

      const calls = planningCalls();
      const [first, afterCommit] = calls;
      expect(first, 'a first planning round').toBeDefined();
      expect(afterCommit, 'a planning round after the tap').toBeDefined();

      // Round one still has it: nothing is committed, so nothing can be lost.
      expect(first!.prompt).toContain('kind "navigate"');
      // The round after the tap does not, and is told why rather than being left
      // to discover it through a rejection.
      expect(afterCommit!.prompt).not.toContain('kind "navigate"');
      expect(afterCommit!.prompt).toContain('"navigate" is no longer available');

      // Proposing it anyway is invalid output, not a dispatch.
      const rejected = calls.find((call) => call.prompt.includes('previous-attempt-rejected'));
      expect(rejected, 'the navigate proposal was rejected').toBeDefined();
      expect(rejected!.prompt).toContain('kind must be one of');

      // Nothing navigated: the flow ends on its own report of being stuck.
      expect(result.passed).toBe(false);
      expect(result.step.error?.code).toBe('ACTION_FAILED');
    } finally {
      project.cleanup();
    }
  }, 180_000);

  // A flow that has lost the thread does not repeat itself back to back, it
  // cycles. Remembering only the previous round let every such loop run to the
  // end of the budget while the runner reported nothing unusual.
  it('stops a flow alternating between two actions that change nothing', async () => {
    const project = createProject({ 'tests/act.e2e.ts': SUITE });
    let round = 0;
    try {
      const result = await run(project, (call) => {
        // Neither of these does anything, and they alternate, so no two
        // consecutive rounds ever propose the same action.
        round += 1;
        return round % 2 === 1
          ? toolOnMatch(call, /heading "Onboarding"/, 'tap')
          : toolOnMatch(call, /Welcome aboard/, 'tap');
      });

      expect(result.passed).toBe(false);
      expect(result.step.error?.code).toBe('STEP_NO_CONCLUSION');
      // Caught well inside the 25-call budget rather than at the end of it.
      expect(planningCalls().length).toBeLessThan(10);

      const notice = planningCalls().find((call) =>
        call.prompt.includes('The screen has not changed'),
      );
      expect(notice, 'the model was told before being cut off').toBeDefined();
      // And told not to answer it by going somewhere else.
      expect(notice!.prompt).toContain('Do not respond by starting over somewhere else');

      // The failure says how far the flow got, not just that it stopped.
      expect(result.step.error?.message).toContain('it got as far as');
    } finally {
      project.cleanup();
    }
  }, 180_000);
});

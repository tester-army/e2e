/**
 * Locate disambiguation (spec 02-test-api.md, 10-determinism.md).
 *
 * A page of repeated rows gives every derived query several matches, which used
 * to strand the locate sweep even though the runner knew exactly which node the
 * model had selected. The sweep now pins the selected node by position within the
 * match set the query actually returned, and still verifies the node before
 * dispatching, so a page that reordered fails rather than acting on a neighbour.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import {
  fakeCalls,
  installFakeModel,
  locateBestMatch,
  locateNth,
  type FakeCall,
} from '../helpers/fake-model.ts';
import { resultByTitle, runProject, type FixtureProject } from '../helpers/run-project.ts';
import type { RunOutcome } from '../helpers/run-project.ts';

const SUITE = `import { test, expect } from 'e2e';

test('taps the row the model chose, not the first one', async ({ agent, screen, web }) => {
  await web.goto('/rows');
  await agent.tap('the buy button of the second row');
  await expect(screen.getByRole('status')).toHaveText('Beta');
});

test('taps a later row through the same ambiguous query', async ({ agent, screen, web }) => {
  await web.goto('/rows');
  await agent.tap('the buy button of the third row');
  await expect(screen.getByRole('status')).toHaveText('Gamma');
});

test('reports controls it cannot tell apart', async ({ agent, web }) => {
  await web.goto('/rows');
  await agent.tap('the Twin button');
});

test('reports them the same way under a tight clock', async ({ agent, web }) => {
  await web.goto('/rows');
  await agent.tap('the Twin button', { timeout: 400 });
});
`;

/** The instruction names which repeated row the model is meant to pick. */
function respond(call: FakeCall): unknown {
  const buy = /Kup teraz/;
  switch (call.instruction) {
    case 'the buy button of the second row':
      return locateNth(call, buy, 1);
    case 'the buy button of the third row':
      return locateNth(call, buy, 2);
    default:
      return locateBestMatch(call);
  }
}

describe('locate ambiguity', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    const model = installFakeModel(respond);
    const run = await runProject(
      { 'tests/rows.e2e.ts': SUITE },
      {
        appUrl: app.url,
        config: { tests: 'tests/**/*.e2e.ts', reporters: ['json'], agent: { model } },
      },
    );
    outcome = run.outcome;
    project = run.project;
  }, 180_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  const stepOf = (title: string, api: string) => {
    const attempt = resultByTitle(outcome, title).attempts.at(-1)!;
    const step = attempt.steps.find((candidate) => candidate.api === api);
    if (step === undefined) throw new Error(`no ${api} step in "${title}"`);
    return step;
  };

  it('acts on the selected row when every query matches all of them', () => {
    // Three rows share role, name, and test id. Before indexing, this failed with
    // LOCATOR_AMBIGUOUS after polling to the deadline.
    const title = 'taps the row the model chose, not the first one';
    expect(resultByTitle(outcome, title).status).toBe('passed');
    expect(stepOf(title, 'agent.tap').status).toBe('passed');
  });

  it('does not collapse to the first match', () => {
    // The distinguishing assertion: two runs, same ambiguous queries, different
    // rows. A `.first()` fallback would pass the previous test and fail this one.
    const title = 'taps a later row through the same ambiguous query';
    expect(resultByTitle(outcome, title).status).toBe('passed');
  });

  it('records the indexed query it dispatched through', () => {
    const step = stepOf('taps a later row through the same ambiguous query', 'agent.tap');
    const dispatched = step.events.find(
      (event) => event.kind === 'driver' && event.name === 'tap',
    );
    expect(dispatched?.status).toBe('passed');
    expect(
      step.events.some(
        (event) =>
          event.kind === 'policy' && event.name === 'locate.identity' && event.decision === 'allowed',
      ),
    ).toBe(true);
  });

  it('still fails, with a remedy, on controls that are truly identical', () => {
    // Two buttons stacked at the same rect: same name, same test id, same
    // geometry. Nothing but the instruction can choose, so the error says so
    // instead of listing failed queries and leaving the author to guess.
    const title = 'reports controls it cannot tell apart';
    const error = resultByTitle(outcome, title).attempts.at(-1)!.error!;
    expect(error.code).toBe('LOCATOR_AMBIGUOUS');
    expect(error.message).toContain('indistinguishable from the selected node');
    expect(error.message).toContain('name what distinguishes the one you mean');
  });

  it('reports indistinguishable controls the same way under any clock', () => {
    // Regression: a match whose read timed out used to be dropped silently, so a
    // tight deadline shrank the candidate set until one entry looked unique and
    // the runner indexed onto an arbitrary element. It also made the terminal
    // error code depend on machine speed.
    const tight = resultByTitle(outcome, 'reports them the same way under a tight clock');
    const relaxed = resultByTitle(outcome, 'reports controls it cannot tell apart');
    expect(tight.attempts.at(-1)!.error!.code).toBe(
      relaxed.attempts.at(-1)!.error!.code,
    );
    expect(tight.attempts.at(-1)!.error!.code).toBe('LOCATOR_AMBIGUOUS');
    // No action is dispatched on either path.
    expect(stepOf('reports them the same way under a tight clock', 'agent.tap').metrics!
      .actionSteps).toBe(0);
  });

  it('gives up immediately on controls nothing can separate', () => {
    // Re-sweeping cannot separate same-rect duplicates, so the sweep must not
    // spend the deadline discovering that. This is what turned a 150 s failure
    // on a production page into an immediate one.
    const step = stepOf('reports controls it cannot tell apart', 'agent.tap');
    expect(step.durationMs).toBeLessThan(10_000);
  });

  it('asks the model exactly once per tap', () => {
    // Indexing happens runner-side, so it costs driver reads, never model calls.
    const calls = fakeCalls.filter(
      (call) => call.instruction === 'the buy button of the second row',
    );
    expect(calls).toHaveLength(1);
  });
});

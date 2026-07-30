/**
 * Locate disambiguation (spec 02-test-api.md, 10-determinism.md).
 *
 * A page of repeated rows gives every derived query several matches, which used
 * to strand the locate sweep even though the runner knew exactly which node the
 * model had selected. Ambiguous queries are now dropped and the selection's own
 * reference carries the action, so identity never depends on where the page
 * happened to be when the observation was taken.
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

test('types into the field it chose while the layout moves', async ({ agent, screen, web }) => {
  await web.goto('/drift');
  await agent.type('the second surname field', 'Bravo');
  // The deterministic half of the pair: the second field, named by position from
  // the test rather than by the model, is the one that must carry the text.
  await expect(screen.getByTestId('surname').nth(1)).toHaveValue('Bravo');
  await expect(screen.getByTestId('surname').first()).toHaveValue('');
});
`;

/** The instruction names which repeated node the model is meant to pick. */
function respond(call: FakeCall): unknown {
  const buy = /Kup teraz/;
  switch (call.instruction) {
    case 'the buy button of the second row':
      return locateNth(call, buy, 1);
    case 'the buy button of the third row':
      return locateNth(call, buy, 2);
    case 'the second surname field':
      return locateNth(call, /textbox "Nazwisko"/, 1);
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
    // Three rows share role, name, and test id, so no derived query is unique.
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

  it('dispatches through the reference rather than a positional query', () => {
    // An index would name an order the next run need not have, and the cache
    // refuses to store one anyway. The reference is exact and its node carries a
    // recordable selector, so this is the cheaper answer as well as the safer one.
    const step = stepOf('taps a later row through the same ambiguous query', 'agent.tap');
    const dispatched = step.events.find(
      (event) => event.kind === 'driver' && event.name === 'tap',
    );
    expect(dispatched?.status).toBe('passed');
    expect(
      step.events.some(
        (event) =>
          event.kind === 'policy' &&
          event.name === 'locate.reference' &&
          event.decision === 'allowed',
      ),
    ).toBe(true);
  });

  it('survives a rectangle that moves between observation and sweep', () => {
    // The regression this replaced geometry to fix. Two fields share a name and a
    // test id while the page grows underneath them, so every rect the model saw is
    // stale by the time the queries run. Comparing coordinates called that
    // "indistinguishable" and failed a run that was never ambiguous about which
    // node it meant.
    const title = 'types into the field it chose while the layout moves';
    expect(resultByTitle(outcome, title).status).toBe('passed');
    expect(stepOf(title, 'agent.type').status).toBe('passed');
  });

  it('gives up immediately on an ambiguous sweep it cannot answer', () => {
    // Ambiguity is answered by the reference or not at all: re-running the same
    // queries against the same selection cannot make duplicates unique, so no
    // path here may spend the deadline discovering that.
    for (const title of [
      'taps the row the model chose, not the first one',
      'taps a later row through the same ambiguous query',
    ]) {
      expect(stepOf(title, 'agent.tap').durationMs).toBeLessThan(10_000);
    }
  });

  it('asks the model exactly once per tap', () => {
    // Resolution happens runner-side, so it costs driver reads, never model calls.
    const calls = fakeCalls.filter(
      (call) => call.instruction === 'the buy button of the second row',
    );
    expect(calls).toHaveLength(1);
  });
});

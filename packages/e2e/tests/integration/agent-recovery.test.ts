/**
 * Recovery from a provider that returns nothing.
 *
 * `result.output` is an AI SDK getter that throws `NoOutputGeneratedError`, a
 * different class from a response that parsed and failed validation. Classifying
 * it as infrastructure made a transient blip — a reasoning model spending its
 * whole output budget before emitting the object — fail a run outright.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import {
  fakeCalls,
  installFakeModel,
  locateBestMatch,
  NO_OUTPUT,
  type FakeCall,
} from '../helpers/fake-model.ts';
import { resultByTitle, runProject, type RunOutcome } from '../helpers/run-project.ts';

const SUITE = `import { test, expect } from 'e2e';

test('recovers from one empty response', async ({ app, agent, screen }) => {
  await app.open();
  await agent.tap('the Increment button');
  await expect(screen.getByRole('status')).toHaveText('1');
});

test('gives up when every response is empty', async ({ app, agent }) => {
  await app.open();
  await agent.tap('the Menu button');
});
`;

const RECOVERS = 'the Increment button';
const NEVER = 'the Menu button';

let attempts = 0;

function respond(call: FakeCall): unknown {
  if (call.instruction === NEVER) return NO_OUTPUT;
  if (call.instruction === RECOVERS && attempts++ === 0) return NO_OUTPUT;
  return locateBestMatch(call);
}

describe('an empty provider response', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;

  beforeAll(async () => {
    app = await startFixtureApp();
    attempts = 0;
    const model = installFakeModel(respond);
    const result = await runProject(
      { 'tests/recovery.e2e.ts': SUITE },
      {
        appUrl: app.url,
        config: { tests: 'tests/**/*.e2e.ts', reporters: ['json'], agent: { model } },
      },
    );
    outcome = result.outcome;
    result.project.cleanup();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
  });

  it('re-asks and completes the action', () => {
    expect(resultByTitle(outcome, 'recovers from one empty response').status).toBe('passed');
  });

  // Nothing came back, so there is nothing to quote as rejected. Sending
  // feedback about a response that does not exist only spends tokens.
  it('re-sends the request unchanged rather than asking for a repair', () => {
    const asked = fakeCalls.filter((call) => call.instruction === RECOVERS);
    expect(asked).toHaveLength(2);
    for (const call of asked) {
      expect(call.prompt).not.toContain('previous-attempt-rejected');
    }
  });

  // Retrying forever would spend the whole budget on a provider that is not
  // going to answer, so exhaustion is still a typed failure.
  it('fails as invalid output once the budget is spent, not as infrastructure', () => {
    const test = resultByTitle(outcome, 'gives up when every response is empty');
    expect(test.status).toBe('failed');
    expect(test.attempts.at(-1)!.error?.code).toBe('MODEL_OUTPUT_INVALID');
  });
});

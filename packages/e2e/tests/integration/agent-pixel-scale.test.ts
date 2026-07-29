/**
 * `agent.pixelScale` (spec 05-config.md, 09-drivers.md).
 *
 * Vision providers bill images by area, so the runner can hand the model a
 * resampled screenshot. What has to survive is everything the coordinate
 * contract rests on: the reported geometry must be the geometry of the bytes
 * sent, and a point read off those bytes must still convert back to the CSS
 * pixels the driver dispatches in.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { fakeCalls, installFakeModel, judgment, locatePoint, type FakeCall } from '../helpers/fake-model.ts';
import { resultByTitle, runProject, type FixtureProject } from '../helpers/run-project.ts';
import type { RunOutcome } from '../helpers/run-project.ts';

const SCALE = 0.75;
/** The red pin in CSS pixels; the model is scripted in resized image space. */
const RED_PIN_CSS = { x: 300, y: 60 };
const RED_PIN_IMAGE = { x: RED_PIN_CSS.x * SCALE, y: RED_PIN_CSS.y * SCALE };

const SUITE = `import { test, expect } from 'e2e';

test('judges a downscaled screenshot', async ({ app, agent }) => {
  await app.open();
  await agent.assert('the page renders a chart', { vision: 'only' });
});

test('taps a drawn pin through a downscaled screenshot', async ({ agent, screen, web }) => {
  await web.goto('/canvas');
  await agent.tap('the red pin on the map', { vision: 'only' });
  await expect(screen.getByRole('status')).toHaveText('red');
});
`;

function respond(call: FakeCall): unknown {
  if (call.schemaName === 'agent-judgment-1') return judgment(true, 'it does');
  // Scripted in the coordinate space the model was actually shown.
  return locatePoint(call, RED_PIN_IMAGE, 'a red circle is drawn there');
}

describe('agent.pixelScale', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    const model = installFakeModel(respond);
    const run = await runProject(
      { 'tests/scale.e2e.ts': SUITE },
      {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          reporters: ['json'],
          agent: { model, pixelScale: SCALE },
        },
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

  it('sends an image scaled to the configured fraction of the viewport', () => {
    const title = 'judges a downscaled screenshot';
    expect(resultByTitle(outcome, title).status).toBe('passed');
    const call = fakeCalls.find((candidate) => candidate.instruction === 'the page renders a chart')!;
    expect(call.images).toHaveLength(1);
    // The prompt states the geometry the model must read coordinates against, so
    // it is also the check that the reported size is the size of the bytes.
    expect(call.prompt).toContain(`${1280 * SCALE}x${720 * SCALE} pixels`);
    expect(call.prompt).toContain(`[0, ${1280 * SCALE - 1}]`);
    expect(stepOf(title, 'agent.assert').metrics!.pixelBytes).toBeGreaterThan(0);
  });

  it('still discloses the masked regions after resampling', () => {
    // Resizing happens after masking, so the redacted areas are resampled with
    // everything else and the count the model is told stays true.
    const call = fakeCalls.find((candidate) => candidate.instruction === 'the page renders a chart')!;
    expect(call.prompt).toContain('1 region(s) are masked for security');
  });

  it('converts a point read off the resized image back to CSS pixels', () => {
    // The whole risk of scaling: the model answers in image space, the driver
    // dispatches in CSS space. A missing conversion would tap at 0.75x the
    // intended position and miss the pin.
    const title = 'taps a drawn pin through a downscaled screenshot';
    expect(resultByTitle(outcome, title).status).toBe('passed');
    const step = stepOf(title, 'agent.tap');
    expect(step.explanation).toContain(`(${RED_PIN_CSS.x}, ${RED_PIN_CSS.y})`);
    expect(
      step.events.some(
        (event) => event.kind === 'driver' && event.name === 'tapPoint' && event.status === 'passed',
      ),
    ).toBe(true);
  });
});

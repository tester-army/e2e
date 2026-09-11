/**
 * The act loop's pixel verbs: `screenshot` and `tap_at`. The scripted model
 * cannot see; under test is the runner half — a screenshot attached to a tool
 * result as an image, a point in that image scaled and hit-tested against the
 * tree, a control tapped by id or a bare point tapped through the engine,
 * every later result carrying a fresh screenshot, and both verbs withheld
 * once a secret was filled.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StepExecutor } from '../../src/agent/executor.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { installFakeLoopModel, loopCalls, type LoopCall } from '../helpers/fake-loop-model.ts';
import { resultByTitle, runProject, type FixtureProject } from '../helpers/run-project.ts';
import type { RunOutcome } from '../helpers/run-project.ts';

const SUITE = `import { test, credentials, expect } from '@e2edev/e2e';

test('taps a canvas pin the tree does not list', async ({ app, agent, screen }) => {
  await app.open('/canvas');
  await agent.act('pick the red pin on the map');
  await expect(screen.getByRole('status')).toHaveText('red');
});

test('taps a listed control by id when the point lands on it', async ({ app, agent, screen }) => {
  await app.open('/canvas');
  await agent.act('press the reset button under the map');
  await expect(screen.getByRole('status')).toHaveText('reset');
});

test('opens a bare canvas with a screenshot already attached', async ({ app, agent, screen }) => {
  await app.open('/canvas-bare');
  await agent.act('pick the blue pin on the bare map');
  await expect(screen.getByRole('status')).toHaveText('blue');
});

test('asks for a screenshot before tapping a point', async ({ app, agent }) => {
  await app.open();
  await agent.act('tap blind');
});

test('offers no pixel verbs after a secret fill', async ({ app, agent, screen }) => {
  await app.open();
  await screen.getByLabel('Password').fill(credentials.user('member').password);
  await agent.act('note the page');
});
`;

/** The act model: a screenshot, a point tap in it, then a verdict carrying the tap's result. */
function actModel(call: LoopCall) {
  const conclude = (status: 'passed' | 'failed') => [
    { toolName: 'complete_step', input: { status, summary: call.lastToolResult.slice(0, 1_500) || 'done' } },
  ];
  const calls = call.toolResults.length;
  if (call.prompt.includes('pick the red pin')) {
    // The red pin is drawn at CSS (300, 60); the model taps in the 768-wide screenshot, 0.6 image px per CSS px.
    if (calls === 0) return [{ toolName: 'screenshot', input: {} }];
    if (calls === 1) return [{ toolName: 'tap_at', input: { x: 180, y: 36 } }];
    return conclude('passed');
  }
  if (call.prompt.includes('press the reset button')) {
    // The Reset button is fixed at left 0, top 260, 100 by 30: CSS (50, 275) is image (30, 165).
    if (calls === 0) return [{ toolName: 'screenshot', input: {} }];
    if (calls === 1) return [{ toolName: 'tap_at', input: { x: 30, y: 165 } }];
    return conclude('passed');
  }
  if (call.prompt.includes('pick the blue pin on the bare map')) {
    // The opening prompt carried the screenshot: the blue pin at CSS (80, 140) is image (48, 84), no screenshot call.
    return calls === 0 ? [{ toolName: 'tap_at', input: { x: 48, y: 84 } }] : conclude('passed');
  }
  if (call.prompt.includes('tap blind')) {
    return calls === 0 ? [{ toolName: 'tap_at', input: { x: 300, y: 60 } }] : conclude('failed');
  }
  return conclude('passed');
}

describe('agent.act pixel verbs', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    const model = installFakeLoopModel(actModel);
    const run = await runProject(
      { 'tests/vision-act.e2e.ts': SUITE },
      {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          agents: { default: { model } },
          credentials: { member: { username: 'ada', password: 'hunter2-secret' } },
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

  const stepOf = (title: string) => {
    const attempt = resultByTitle(outcome, title).attempts.at(-1)!;
    const step = attempt.steps.find((candidate) => candidate.api === 'agent.act');
    if (step === undefined) throw new Error(`no agent.act step in "${title}"`);
    return step;
  };
  const turnsOf = (instruction: string) => loopCalls.filter((call) => call.prompt.includes(instruction));

  it('attaches the screenshot to the tool result as an image, then taps the bare point it named', () => {
    expect(resultByTitle(outcome, 'taps a canvas pin the tree does not list').status).toBe('passed');
    const step = stepOf('taps a canvas pin the tree does not list');
    const actions = step.events.filter((event) => event.kind === 'engine');
    expect(actions.map((event) => event.name)).toEqual(['tapAt']);
    expect(actions[0]!.detail).toBe('tap the point (300, 60)');
    // No harness-made model call: the pixels went to the act model itself.
    expect(step.metrics!.modelCalls).toBe(3);
    expect(step.visionInput).toBe(true);
    expect(step.metrics!.pixelBytes).toBeGreaterThan(0);
    const [, second, third] = turnsOf('pick the red pin');
    // The screenshot result is content: the screen text plus an image file part.
    expect(second!.lastToolResult).toContain('"type":"file"');
    expect(second!.lastToolResult).toContain('"mediaType":"image/png"');
    expect(second!.lastToolResult).toContain('tap_at takes coordinates in this image');
    // In pixel mode the tap result carries the changes and a fresh screenshot.
    expect(third!.lastToolResult).toContain('Tapped the point (300, 60); no listed control is there');
    expect(third!.lastToolResult).toMatch(/changed #\S+ status \\"Hit\\" text=\\"red\\"/);
    expect(third!.lastToolResult).toContain('"type":"file"');
  });

  it('taps a listed control through its id when the point lands on it', () => {
    expect(resultByTitle(outcome, 'taps a listed control by id when the point lands on it').status).toBe('passed');
    const step = stepOf('taps a listed control by id when the point lands on it');
    const actions = step.events.filter((event) => event.kind === 'engine');
    expect(actions.map((event) => event.name)).toEqual(['tap']);
    expect(actions[0]!.detail).toBe('tap button "Reset"');
    const [, , third] = turnsOf('press the reset button');
    expect(third!.lastToolResult).toMatch(/Tapped #\S+ button \\"Reset\\", the control at \(50, 275\)/);
  });

  it('attaches a screenshot to the opening prompt of a screen with nothing to tap by id', () => {
    expect(resultByTitle(outcome, 'opens a bare canvas with a screenshot already attached').status).toBe('passed');
    const step = stepOf('opens a bare canvas with a screenshot already attached');
    expect(step.events.filter((event) => event.kind === 'engine').map((event) => event.name)).toEqual(['tapAt']);
    expect(step.metrics!.modelCalls).toBe(2);
    expect(step.visionInput).toBe(true);
    const [first] = turnsOf('pick the blue pin on the bare map');
    expect(first!.prompt).toContain('Screenshot attached: 768 by 432 pixels (0.6 per CSS pixel)');
    // An ordinary page opens tree-only: one listed control is enough to act by id.
    const [home] = turnsOf('tap blind');
    expect(home!.prompt).not.toContain('Screenshot attached');
  });

  it('refuses a point tap before any screenshot, without spending an action', () => {
    const result = resultByTitle(outcome, 'asks for a screenshot before tapping a point');
    expect(result.status).toBe('failed');
    expect(result.attempts.at(-1)!.error?.message).toContain('No screenshot has been taken in this step');
    const step = stepOf('asks for a screenshot before tapping a point');
    expect(step.events.filter((event) => event.kind === 'engine')).toHaveLength(0);
    expect(step.metrics!.actionSteps).toBe(0);
  });

  it('leaves both pixel verbs out of the vocabulary once a secret was filled', () => {
    expect(resultByTitle(outcome, 'offers no pixel verbs after a secret fill').status).toBe('passed');
    const [first] = turnsOf('note the page');
    expect(first!.toolNames).not.toContain('screenshot');
    expect(first!.toolNames).not.toContain('tap_at');
    const [untainted] = turnsOf('pick the red pin');
    expect(untainted!.toolNames).toContain('screenshot');
    expect(untainted!.toolNames).toContain('tap_at');
  });
});

/**
 * An executor that fires a point tap and a node tap without awaiting the
 * first: both queue in call order, so the point is hit-tested against the
 * screen it was named on and lands before the node tap.
 */
const racer: StepExecutor = {
  name: 'racer',
  version: '1',
  async runStep(context) {
    const observation = await context.observe();
    const reset = /#(\S+) button "Reset"/.exec(observation.text)?.[1];
    if (reset === undefined) return { status: 'failed', summary: 'no reset button on screen' };
    const [point] = await Promise.all([context.actions.tapAt({ x: 300, y: 60 }), context.actions.tap({ id: reset })]);
    return { status: point.target === undefined ? 'passed' : 'failed', summary: point.summary };
  },
};

describe('actions.tapAt from a custom executor', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    const run = await runProject(
      {
        'tests/race.e2e.ts': `import { test, expect } from '@e2edev/e2e';

test('a point tap issued alongside a node tap lands first', async ({ app, agent, screen }) => {
  await app.open('/canvas');
  await agent.act('pick the red pin, then reset');
  await expect(screen.getByRole('status')).toHaveText('reset');
});
`,
      },
      {
        appUrl: app.url,
        config: { tests: 'tests/**/*.e2e.ts', agents: { default: { executor: racer } } },
      },
    );
    outcome = run.outcome;
    project = run.project;
  }, 180_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('runs the hit test and the tap in call order, and reports a bare point as such', () => {
    const result = resultByTitle(outcome, 'a point tap issued alongside a node tap lands first');
    expect(result.status).toBe('passed');
    const step = result.attempts.at(-1)!.steps.find((candidate) => candidate.api === 'agent.act')!;
    const actions = step.events.filter((event) => event.kind === 'engine').map((event) => event.name);
    expect(actions).toEqual(['tapAt', 'tap']);
    expect(step.metrics!.modelCalls).toBe(0);
    expect(step.model).toBeUndefined();
  });
});

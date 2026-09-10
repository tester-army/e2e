/**
 * The act loop's pixel verbs: `tap_visual` and `look`. The scripted models
 * cannot see; under test is the runner half — pixels captured and handed to
 * the pinned vision model, the located point scaled and hit-tested against
 * the tree, a control tapped by id or a bare point tapped through the engine,
 * an abstain relayed without a tap, and both verbs withheld once a secret was
 * filled.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { createFakeModel, fakeCalls, type FakeCall } from '../helpers/fake-model.ts';
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

test('describes the screen from pixels', async ({ app, agent }) => {
  await app.open('/canvas');
  await agent.act('say what colour the pins are');
});

test('relays an abstain without tapping anything', async ({ app, agent }) => {
  await app.open('/canvas');
  await agent.act('tap the green pin');
});

test('offers no pixel verbs after a secret fill', async ({ app, agent, screen }) => {
  await app.open();
  await screen.getByLabel('Password').fill(credentials.user('member').password);
  await agent.act('note the page');
});
`;

/** The act model: one pixel verb, then a verdict carrying the verb's result. */
function actModel(call: LoopCall) {
  const conclude = (status: 'passed' | 'failed') => [
    { toolName: 'complete_step', input: { status, summary: call.lastToolResult.slice(0, 1_500) || 'done' } },
  ];
  if (call.prompt.includes('pick the red pin')) {
    return call.toolResults.length === 0 ? [{ toolName: 'tap_visual', input: { description: 'the red pin on the map' } }] : conclude('passed');
  }
  if (call.prompt.includes('press the reset button')) {
    return call.toolResults.length === 0
      ? [{ toolName: 'tap_visual', input: { description: 'the Reset button under the map' } }]
      : conclude('passed');
  }
  if (call.prompt.includes('say what colour')) {
    return call.toolResults.length === 0 ? [{ toolName: 'look', input: { question: 'what colour are the pins?' } }] : conclude('passed');
  }
  if (call.prompt.includes('tap the green pin')) {
    return call.toolResults.length === 0 ? [{ toolName: 'tap_visual', input: { description: 'the green pin' } }] : conclude('failed');
  }
  return conclude('passed');
}

/** The vision model: points and descriptions scripted by the fenced instruction. */
function visionModel(call: FakeCall): unknown {
  if (call.schemaName === 'agent-point-1') {
    const base = { protocolVersion: 'agent-point-1', kind: 'clickable', abstainReason: null, expectedText: null, reason: null };
    // The red pin is drawn at (300, 60) on a canvas fixed at the viewport origin.
    if (call.instruction.includes('red pin')) return { ...base, found: true, x: 300, y: 60, expectedText: 'red pin' };
    // The Reset button is fixed at left 0, top 260, 100 by 30.
    if (call.instruction.includes('Reset')) return { ...base, found: true, x: 50, y: 275, expectedText: 'Reset' };
    return { ...base, found: false, x: null, y: null, kind: null, abstainReason: 'not_visible', reason: 'there is no green pin' };
  }
  if (call.schemaName === 'agent-look-1') {
    return {
      protocolVersion: 'agent-look-1',
      topLayer: 'none',
      summary: 'A grey map with two round pins.',
      interactiveElements: ['red pin, circle, top right of the map', 'blue pin, circle, bottom left of the map'],
      formFields: [],
      errors: [],
      answer: 'red and blue',
    };
  }
  throw new Error(`unexpected schema ${call.schemaName}`);
}

describe('agent.act pixel verbs', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    const model = installFakeLoopModel(actModel);
    fakeCalls.length = 0;
    const vision = createFakeModel(visionModel, { modelId: 'scripted-grounding' });
    const run = await runProject(
      { 'tests/vision-act.e2e.ts': SUITE },
      {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          agents: { default: { model, visionModel: vision } },
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

  it('taps the bare point the vision model located on a canvas the tree cannot describe', () => {
    expect(resultByTitle(outcome, 'taps a canvas pin the tree does not list').status).toBe('passed');
    const step = stepOf('taps a canvas pin the tree does not list');
    const actions = step.events.filter((event) => event.kind === 'engine');
    expect(actions.map((event) => event.name)).toEqual(['tapAt']);
    expect(actions[0]!.detail).toContain('tap the point (300, 60)');
    // The localization is one model call of the step, sent to the pinned vision model with the pixels.
    expect(step.events.some((event) => event.kind === 'model' && event.name === 'agent-point-1')).toBe(true);
    const located = fakeCalls.find((call) => call.schemaName === 'agent-point-1' && call.instruction.includes('red pin'))!;
    expect(located.modelId).toBe('scripted-grounding');
    expect(located.images).toHaveLength(1);
    expect(located.system).toContain('Return absolute pixel coordinates');
    expect(step.visionInput).toBe(true);
    expect(step.metrics!.pixelBytes).toBeGreaterThan(0);
    // The act model read what happened and what was under the point.
    const [, second] = turnsOf('pick the red pin');
    expect(second!.lastToolResult).toContain('Tapped the point (300, 60) for "the red pin on the map"; no listed control is there');
    expect(second!.lastToolResult).toMatch(/changed #\S+ status "Hit" text="red"/);
  });

  it('taps a listed control through its id when the located point lands on it', () => {
    expect(resultByTitle(outcome, 'taps a listed control by id when the point lands on it').status).toBe('passed');
    const step = stepOf('taps a listed control by id when the point lands on it');
    const actions = step.events.filter((event) => event.kind === 'engine');
    expect(actions.map((event) => event.name)).toEqual(['tap']);
    expect(actions[0]!.detail).toBe('tap button "Reset"');
    const [, second] = turnsOf('press the reset button');
    expect(second!.lastToolResult).toMatch(/^Tapped #\S+ button "Reset", the control at \(50, 275\)/);
  });

  it('describes the screen as text from the vision model, then the tree changes', () => {
    expect(resultByTitle(outcome, 'describes the screen from pixels').status).toBe('passed');
    const [, second] = turnsOf('say what colour');
    expect(second!.lastToolResult).toContain('Screen as seen in pixels');
    expect(second!.lastToolResult).toContain('- red pin, circle, top right of the map');
    expect(second!.lastToolResult).toContain('Answer: red and blue');
    expect(second!.lastToolResult).toContain('Screen unchanged since revision');
    const looked = fakeCalls.find((call) => call.schemaName === 'agent-look-1')!;
    expect(looked.instruction).toBe('what colour are the pins?');
    expect(looked.images).toHaveLength(1);
    const step = stepOf('describes the screen from pixels');
    expect(step.events.filter((event) => event.kind === 'engine')).toHaveLength(0);
    expect(step.metrics!.modelCalls).toBe(3);
  });

  it('relays an abstain with its recovery and taps nothing', () => {
    const result = resultByTitle(outcome, 'relays an abstain without tapping anything');
    expect(result.status).toBe('failed');
    expect(result.attempts.at(-1)!.error?.message).toContain('no safe target for "the green pin" (there is no green pin)');
    expect(result.attempts.at(-1)!.error?.message).toContain('Bring it on screen first');
    const step = stepOf('relays an abstain without tapping anything');
    expect(step.events.filter((event) => event.kind === 'engine')).toHaveLength(0);
    expect(step.metrics!.actionSteps).toBe(0);
  });

  it('leaves both pixel verbs out of the vocabulary once a secret was filled', () => {
    expect(resultByTitle(outcome, 'offers no pixel verbs after a secret fill').status).toBe('passed');
    const [first] = turnsOf('note the page');
    expect(first!.toolNames).not.toContain('tap_visual');
    expect(first!.toolNames).not.toContain('look');
    const [untainted] = turnsOf('pick the red pin');
    expect(untainted!.toolNames).toContain('tap_visual');
    expect(untainted!.toolNames).toContain('look');
  });
});

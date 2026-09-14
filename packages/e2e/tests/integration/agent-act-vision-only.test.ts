/**
 * `agent.act` with `vision: 'only'` and `vision: true`. The scripted model
 * cannot see; under test is the runner half: the tree withheld from every
 * observation and prompt, a screenshot on the opening prompt and on every
 * result, the point-addressed vocabulary resolving points onto listed
 * controls (typed, pressed, selected, scrolled by id underneath), a bare
 * point tapped through the engine, the report's `visionOnly` mark, and the
 * policy refusals: a secret in the params, a viewport already tainted.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StepExecutor } from '../../src/agent/executor.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { installFakeLoopModel, loopCalls, type LoopCall } from '../helpers/fake-loop-model.ts';
import { resultByTitle, runProject, type FixtureProject } from '../helpers/run-project.ts';
import type { RunOutcome } from '../helpers/run-project.ts';

const SUITE = `import { test, credentials, expect } from 'e2e';

test('taps a canvas pin from pixels alone', async ({ app, agent, screen }) => {
  await app.open('/canvas');
  await agent.act('pick the red pin on the map', { vision: 'only' });
  await expect(screen.getByRole('status')).toHaveText('red');
});

test('types, presses, and selects through points', async ({ app, agent, screen }) => {
  await app.open('/canvas');
  await agent.act('write a note and pick the warm tint', { vision: 'only' });
  await expect(screen.getByRole('status')).toHaveText('tint: warm');
});

test('refuses a point with nothing typeable under it', async ({ app, agent }) => {
  await app.open('/canvas');
  await agent.act('type into the map', { vision: 'only' });
});

test('refuses a secret in a pixels-only step', async ({ app, agent }) => {
  await app.open('/');
  await agent.act('sign in', { vision: 'only', params: { password: credentials.user('member').password } });
});

test('refuses a pixels-only step on a tainted viewport', async ({ app, agent, screen }) => {
  await app.open('/');
  await screen.getByLabel('Password').fill(credentials.user('member').password);
  await agent.act('note the page', { vision: 'only' });
});

test('opens an ordinary page in pixel mode with vision true', async ({ app, agent }) => {
  await app.open('/');
  await agent.act('note the home page', { vision: true });
});

test('types into a drawn field through the keyboard', async ({ app, agent, screen }) => {
  await app.open('/canvas');
  await agent.act('type hi into the drawn field and submit', { vision: 'only' });
  await expect(screen.getByRole('status')).toHaveText('drawn: hi');
});

test('types into a focused drawn field from the default vocabulary', async ({ app, agent, screen }) => {
  await app.open('/canvas');
  await agent.act('focus the drawn field, type ok, submit');
  await expect(screen.getByRole('status')).toHaveText('drawn: ok');
});

test('types into a listed widget the engine cannot fill', async ({ app, agent, screen }) => {
  await app.open('/canvas');
  await agent.act('type yo into the pad');
  await expect(screen.getByRole('status')).toHaveText('pad: yo');
});

test('refuses focused typing when nothing editable has focus', async ({ app, agent }) => {
  await app.open('/');
  await agent.act('type blind');
});
`;

function actModel(call: LoopCall) {
  const conclude = (status: 'passed' | 'failed') => [
    { toolName: 'complete_step', input: { status, summary: call.lastToolResult.slice(0, 1_500) || 'done' } },
  ];
  const calls = call.toolResults.length;
  if (call.prompt.includes('pick the red pin')) {
    // The red pin is drawn at CSS (300, 60); the screenshot is 768 wide, 0.6 image px per CSS px.
    return calls === 0 ? [{ toolName: 'tap_at', input: { x: 180, y: 36 } }] : conclude('passed');
  }
  if (call.prompt.includes('write a note')) {
    // Note input at CSS (0..200, 300..330): its center (100, 315) is image (60, 189).
    // Tint select at CSS (0..200, 340..370): center (100, 355) is image (60, 213).
    if (calls === 0) return [{ toolName: 'type_at', input: { x: 60, y: 189, value: 'hello' } }];
    if (calls === 1) return [{ toolName: 'press_at', input: { x: 60, y: 189, key: 'Enter' } }];
    if (calls === 2) return [{ toolName: 'select_at', input: { x: 60, y: 213, value: 'warm' } }];
    if (calls === 3) return [{ toolName: 'scroll', input: { direction: 'down' } }];
    return conclude('passed');
  }
  if (call.prompt.includes('type into the map')) {
    // A point on the status line: nothing listed there is a control, and the keyboard fallback needs a point only.
    return calls === 0 ? [{ toolName: 'select_at', input: { x: 30, y: 30, value: 'x' } }] : conclude('failed');
  }
  if (call.prompt.includes('type hi into the drawn field')) {
    // The canvas at CSS (200, 100) is image (120, 60): no listed control there, so type_at taps to focus it and types.
    if (calls === 0) return [{ toolName: 'type_at', input: { x: 120, y: 60, value: 'hi' } }];
    if (calls === 1) return [{ toolName: 'press_at', input: { key: 'Enter' } }];
    return conclude('passed');
  }
  if (call.prompt.includes('focus the drawn field')) {
    if (calls === 0) return [{ toolName: 'screenshot', input: {} }];
    if (calls === 1) return [{ toolName: 'tap_at', input: { x: 120, y: 60 } }];
    if (calls === 2) return [{ toolName: 'type', input: { value: 'ok' } }];
    if (calls === 3) return [{ toolName: 'press', input: { key: 'Enter' } }];
    return conclude('passed');
  }
  if (call.prompt.includes('type yo into the pad')) {
    const pad = /#(\S+) application "Pad"/.exec(call.prompt)?.[1] ?? 'missing';
    if (calls === 0) return [{ toolName: 'type', input: { target: pad, value: 'yo' } }];
    if (calls === 1) return [{ toolName: 'press', input: { target: pad, key: 'Enter' } }];
    return conclude('passed');
  }
  if (call.prompt.includes('type blind')) {
    return calls === 0 ? [{ toolName: 'type', input: { value: 'nope' } }] : conclude('failed');
  }
  return conclude('passed');
}

describe('agent.act with vision only', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    const model = installFakeLoopModel(actModel);
    const run = await runProject(
      { 'tests/vision-only.e2e.ts': SUITE },
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

  it('opens with a screenshot and no tree, and offers only the point-addressed vocabulary', () => {
    expect(resultByTitle(outcome, 'taps a canvas pin from pixels alone').status).toBe('passed');
    const [first] = turnsOf('pick the red pin');
    expect(first!.prompt).toContain('Current screen (revision ');
    expect(first!.prompt).toContain('Screenshot attached: 768 by 432 pixels (0.6 per CSS pixel)');
    // No node line and no id reach the model: the fixture's Reset button and status are listed in the tree.
    expect(first!.prompt).not.toMatch(/#n\d+/);
    expect(first!.prompt).not.toContain('button "Reset"');
    expect(first!.prompt).not.toContain(' nodes)');
    expect(first!.toolNames).toEqual(['complete_step', 'navigate', 'observe', 'press_at', 'scroll', 'select_at', 'tap_at', 'type_at']);
    expect(first!.system).toContain('anything else is tapped to focus it and typed into through the keyboard');
    expect(first!.system).toContain('You see the screen as a screenshot and nothing else');
    expect(first!.system).not.toContain('stable ids like "n42"');
  });

  it('taps the bare point through the engine and marks the step pixels-only in the report', () => {
    const step = stepOf('taps a canvas pin from pixels alone');
    const actions = step.events.filter((event) => event.kind === 'engine');
    expect(actions.map((event) => event.name)).toEqual(['tapAt']);
    expect(actions[0]!.detail).toBe('tap the point (300, 60)');
    expect(step.visionOnly).toBe(true);
    expect(step.visionInput).toBe(true);
    // The tree is still captured and hit-tested, but contributes nothing to the request.
    expect(step.metrics!.observationBytes).toBe(0);
    expect(step.metrics!.pixelBytes).toBeGreaterThan(0);
    const [, second] = turnsOf('pick the red pin');
    expect(second!.lastToolResult).toContain('Tapped the point (300, 60); no listed control is there');
    // The result names what the tap hit without quoting a line or an id.
    expect(second!.lastToolResult).not.toMatch(/#n\d+/);
    expect(second!.lastToolResult).toContain('"type":"file"');
    expect(second!.lastToolResult).toContain('Screen now (revision ');
  });

  it('types, presses, selects, and scrolls through points, acting on the listed control by id underneath', () => {
    expect(resultByTitle(outcome, 'types, presses, and selects through points').status).toBe('passed');
    const step = stepOf('types, presses, and selects through points');
    const actions = step.events.filter((event) => event.kind === 'engine');
    expect(actions.map((event) => event.name)).toEqual(['type', 'press', 'selectOption', 'scroll']);
    expect(actions[0]!.detail).toBe('type "hello" into textbox "Note"');
    expect(actions[1]!.detail).toBe('press "Enter" on textbox "Note"');
    expect(actions[2]!.detail).toBe('select "warm" in combobox "Tint"');
    const [, second, third, fourth] = turnsOf('write a note');
    // Tool results are JSON-encoded content, so quoted names read escaped.
    expect(second!.lastToolResult).toMatch(/Typed into textbox \\"Note\\", the control at \(100, 315\)\./);
    expect(second!.lastToolResult).not.toMatch(/#n\d+/);
    expect(third!.lastToolResult).toMatch(/Pressed Enter on textbox \\"Note\\", the control at \(100, 315\)\./);
    expect(fourth!.lastToolResult).toMatch(/Selected \\"warm\\" in combobox \\"Tint\\", the control at \(100, 355\)\./);
  });

  it('reports a point with nothing selectable under it as an action failure the model can read', () => {
    const result = resultByTitle(outcome, 'refuses a point with nothing typeable under it');
    expect(result.status).toBe('failed');
    const [, second] = turnsOf('type into the map');
    // The lead echoes the model's image coordinates; the hit summary speaks in viewport pixels.
    expect(second!.lastToolResult).toContain(
      'select_at (30, 30) failed: nothing the screen lists is at (50, 50); select_at needs a control the screen lists.',
    );
    const step = stepOf('refuses a point with nothing typeable under it');
    expect(step.events.filter((event) => event.kind === 'engine')).toHaveLength(0);
    expect(step.metrics!.actionSteps).toBe(0);
  });

  it('refuses a secret in a pixels-only step before any model call', () => {
    const result = resultByTitle(outcome, 'refuses a secret in a pixels-only step');
    expect(result.status).toBe('failed');
    const error = result.attempts.at(-1)!.error!;
    expect(error.code).toBe('POLICY_DENIED');
    expect(error.message).toContain('a secret in its params');
    expect(stepOf('refuses a secret in a pixels-only step').metrics!.modelCalls).toBe(0);
    expect(turnsOf('sign in')).toHaveLength(0);
  });

  it('refuses a pixels-only step on a tainted viewport before any model call', () => {
    const result = resultByTitle(outcome, 'refuses a pixels-only step on a tainted viewport');
    expect(result.status).toBe('failed');
    const error = result.attempts.at(-1)!.error!;
    expect(error.code).toBe('POLICY_DENIED');
    expect(error.message).toContain('PIXEL_TAINTED');
    const step = stepOf('refuses a pixels-only step on a tainted viewport');
    expect(step.metrics!.modelCalls).toBe(0);
    expect(step.events.some((event) => event.kind === 'policy' && event.code === 'PIXEL_TAINTED')).toBe(true);
    expect(turnsOf('note the page')).toHaveLength(0);
  });

  it('taps a drawn field to focus it and types through the keyboard, then presses Enter on the focused field', () => {
    expect(resultByTitle(outcome, 'types into a drawn field through the keyboard').status).toBe('passed');
    const step = stepOf('types into a drawn field through the keyboard');
    const actions = step.events.filter((event) => event.kind === 'engine');
    expect(actions.map((event) => event.name)).toEqual(['tapAt', 'typeText', 'pressKey']);
    expect(actions[1]!.detail).toBe('type "hi" into the focused field');
    expect(actions[2]!.detail).toBe('press "Enter" on the focused field');
    const [, second, third] = turnsOf('type hi into the drawn field');
    expect(second!.lastToolResult).toContain('Typed into the field at (120, 60) (tapped to focus it; nothing the screen lists is at (200, 100)).');
    expect(third!.lastToolResult).toContain('Pressed Enter on the focused field.');
  });

  it('offers type and press without a target in the default vocabulary, typing into the focused drawn field', () => {
    expect(resultByTitle(outcome, 'types into a focused drawn field from the default vocabulary').status).toBe('passed');
    const step = stepOf('types into a focused drawn field from the default vocabulary');
    const actions = step.events.filter((event) => event.kind === 'engine');
    expect(actions.map((event) => event.name)).toEqual(['tapAt', 'typeText', 'pressKey']);
    const [first, , , fourth] = turnsOf('focus the drawn field');
    expect(first!.toolNames).toContain('type');
    expect(first!.toolNames).not.toContain('dismiss_keyboard');
    expect(fourth!.lastToolResult).toContain('Typed into the focused field.');
  });

  it('falls back to focusing an unfillable listed node and typing through the keyboard', () => {
    expect(resultByTitle(outcome, 'types into a listed widget the engine cannot fill').status).toBe('passed');
    const step = stepOf('types into a listed widget the engine cannot fill');
    const actions = step.events.filter((event) => event.kind === 'engine');
    // Nothing had focus, so the focused attempt was refused before the node was tapped and typed into.
    expect(actions.map((event) => `${event.name}:${event.status}`)).toEqual(['type:failed', 'typeText:failed', 'tap:passed', 'typeText:passed', 'press:passed']);
    const [, second] = turnsOf('type yo into the pad');
    expect(second!.lastToolResult).toMatch(/#\S+ is not an input; tapped it to focus it and typed through the keyboard\./);
  });

  it('refuses focused typing into nothing editable, as an action failure the model reads', () => {
    expect(resultByTitle(outcome, 'refuses focused typing when nothing editable has focus').status).toBe('failed');
    const step = stepOf('refuses focused typing when nothing editable has focus');
    // The engine refused before any keystroke: the action was reserved, not committed.
    expect(step.events.filter((event) => event.kind === 'engine' && event.status === 'passed')).toHaveLength(0);
    const [, second] = turnsOf('type blind');
    expect(second!.lastToolResult).toContain('nothing that takes keystrokes has focus: the typed text would reach no field');
  });

  it('opens an ordinary page with the tree and a screenshot under vision true', () => {
    expect(resultByTitle(outcome, 'opens an ordinary page in pixel mode with vision true').status).toBe('passed');
    const [first] = turnsOf('note the home page');
    expect(first!.prompt).toMatch(/#n\d+ button "Increment"/);
    expect(first!.prompt).toContain('Screenshot attached: 768 by 432 pixels');
    expect(first!.toolNames).toContain('tap');
    expect(first!.toolNames).toContain('tap_at');
    expect(first!.toolNames).toContain('screenshot');
    const step = stepOf('opens an ordinary page in pixel mode with vision true');
    expect(step.visionInput).toBe(true);
    expect(step.visionOnly).toBeUndefined();
  });
});

/** An executor that reads the pixels-only view directly, and resolves a point itself. */
const pixelReader: StepExecutor = {
  name: 'pixel-reader',
  version: '1',
  async runStep(context) {
    const observation = await context.observe({ tree: true });
    const treeWithheld = observation.text === '' && observation.tree === undefined && observation.pixels !== undefined;
    const hit = await context.actions.hitTest({ x: 50, y: 275 });
    if (hit.control === undefined) return { status: 'failed', summary: hit.summary };
    await context.actions.tap(hit.control);
    return { status: treeWithheld && context.vision === 'only' ? 'passed' : 'failed', summary: hit.summary };
  },
};

describe('a custom executor under vision only', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    const run = await runProject(
      {
        'tests/reader.e2e.ts': `import { test, expect } from 'e2e';

test('sees pixels and no tree, and resolves a point onto a listed control', async ({ app, agent, screen }) => {
  await app.open('/canvas');
  await agent.act('press reset', { vision: 'only' });
  await expect(screen.getByRole('status')).toHaveText('reset');
});
`,
      },
      {
        appUrl: app.url,
        config: { tests: 'tests/**/*.e2e.ts', agents: { default: { executor: pixelReader } } },
      },
    );
    outcome = run.outcome;
    project = run.project;
  }, 180_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('withholds the tree from observe() even when asked, and hit-tests against it underneath', () => {
    const result = resultByTitle(outcome, 'sees pixels and no tree, and resolves a point onto a listed control');
    expect(result.status).toBe('passed');
    const step = result.attempts.at(-1)!.steps.find((candidate) => candidate.api === 'agent.act')!;
    expect(step.events.filter((event) => event.kind === 'engine').map((event) => event.name)).toEqual(['tap']);
    expect(step.explanation).toBe('button "Reset", the control at (50, 275)');
    expect(step.visionOnly).toBe(true);
  });
});

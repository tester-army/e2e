/**
 * The act loop's pixel verbs: `screenshot`, `tap_at`, `type_at`, `press_at`,
 * and `select_at`. The scripted model cannot see; under test is the runner
 * half: a screenshot attached to a tool result as an image, a point in that
 * image scaled and hit-tested against the tree, a listed control acted on by
 * id underneath (tapped, typed, pressed, selected), a bare point tapped
 * through the engine or focused and typed into through the keyboard, every
 * later result carrying a fresh screenshot, the point verbs answering with a
 * line before any screenshot, and every pixel verb withheld once a secret was
 * filled.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StepExecutor } from '../../src/agent/executor.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { installFakeLoopModel, loopCalls, type LoopCall } from '../helpers/fake-loop-model.ts';
import { resultByTitle, runProject, type FixtureProject } from '../helpers/run-project.ts';
import type { RunOutcome } from '../helpers/run-project.ts';

const SUITE = `import { test, credentials, expect } from 'e2e';

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

test('asks for a screenshot before typing at a point', async ({ app, agent }) => {
  await app.open();
  await agent.act('type at a point before any screenshot');
});

test('offers no pixel verbs after a secret fill', async ({ app, agent, screen }) => {
  await app.open();
  await screen.getByLabel('Password').fill(credentials.user('member').password);
  await agent.act('note the page');
});

test('types, presses, and selects through points', async ({ app, agent, screen }) => {
  await app.open('/canvas');
  await agent.act('write a note and pick the warm tint');
  await expect(screen.getByRole('status')).toHaveText('tint: warm');
});

test('refuses a point with nothing selectable under it', async ({ app, agent }) => {
  await app.open('/canvas');
  await agent.act('select on the map');
});

test('types into a drawn field through the keyboard', async ({ app, agent, screen }) => {
  await app.open('/canvas');
  await agent.act('type hi into the drawn field and submit');
  await expect(screen.getByRole('status')).toHaveText('drawn: hi');
});

test('types into a focused drawn field with type and press without a target', async ({ app, agent, screen }) => {
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

test('stops a streak of failing point verbs', async ({ app, agent }) => {
  await app.open('/canvas');
  await agent.act('pick options off the empty map margin');
});

test('reads a repaint the tree cannot list off the screenshot', async ({ app, agent }) => {
  await app.open('/canvas');
  await agent.act('tap the map twice, then the margin twice');
});
`;

/** The act model: a screenshot, then point verbs in it, then a verdict carrying the last result. */
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
  if (call.prompt.includes('type at a point before any screenshot')) {
    return calls === 0 ? [{ toolName: 'type_at', input: { x: 60, y: 189, value: 'nope' } }] : conclude('failed');
  }
  if (call.prompt.includes('write a note')) {
    // Note input at CSS (0..200, 300..330): its center (100, 315) is image (60, 189).
    // Tint select at CSS (0..200, 340..370): center (100, 355) is image (60, 213).
    if (calls === 0) return [{ toolName: 'screenshot', input: {} }];
    if (calls === 1) return [{ toolName: 'type_at', input: { x: 60, y: 189, value: 'hello' } }];
    if (calls === 2) return [{ toolName: 'press_at', input: { x: 60, y: 189, key: 'Enter' } }];
    if (calls === 3) return [{ toolName: 'select_at', input: { x: 60, y: 213, value: 'warm' } }];
    return conclude('passed');
  }
  if (call.prompt.includes('select on the map')) {
    // A point on the status line: nothing listed there is a control.
    if (calls === 0) return [{ toolName: 'screenshot', input: {} }];
    if (calls === 1) return [{ toolName: 'select_at', input: { x: 30, y: 30, value: 'x' } }];
    return conclude('failed');
  }
  if (call.prompt.includes('type hi into the drawn field')) {
    // The canvas at CSS (200, 100) is image (120, 60): no listed control there, so type_at taps to focus it and types.
    if (calls === 0) return [{ toolName: 'screenshot', input: {} }];
    if (calls === 1) return [{ toolName: 'type_at', input: { x: 120, y: 60, value: 'hi' } }];
    if (calls === 2) return [{ toolName: 'press', input: { key: 'Enter' } }];
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
  if (call.prompt.includes('pick options off the empty map margin')) {
    // Five select_at calls on the blank page right of the controls: nothing listed is there, so each
    // fails, and each names a new point so only the failure streak can stop the loop.
    if (calls === 0) return [{ toolName: 'screenshot', input: {} }];
    if (calls <= 5) return [{ toolName: 'select_at', input: { x: 380 + calls * 20, y: 180 + calls * 10, value: 'x' } }];
    return conclude('failed');
  }
  if (call.prompt.includes('tap the map twice, then the margin twice')) {
    // After the red pin, the same miss point at CSS (100, 100) twice: the status text repeats, so the
    // listing stands still while the map paints a new tap count. Then the blank margin at CSS (700, 500)
    // twice: nothing there repaints.
    if (calls === 0) return [{ toolName: 'screenshot', input: {} }];
    if (calls === 1) return [{ toolName: 'tap_at', input: { x: 180, y: 36 } }];
    if (calls <= 3) return [{ toolName: 'tap_at', input: { x: 60, y: 60 } }];
    if (calls <= 5) return [{ toolName: 'tap_at', input: { x: 420, y: 300 } }];
    return conclude('passed');
  }
  return conclude('passed');
}

const POINT_VERBS = ['screenshot', 'tap_at', 'type_at', 'press_at', 'select_at'];

describe('agent.act pixel verbs', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    const model = installFakeLoopModel(actModel);
    const run = await runProject(
      { 'tests/pixel-tools.e2e.ts': SUITE },
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

  it('opens tree-first with every pixel verb on offer, and the rules say to prefer ids', () => {
    const [first] = turnsOf('pick the red pin');
    expect(first!.prompt).toMatch(/#n\d+ button "Reset"/);
    expect(first!.prompt).not.toContain('Screenshot attached');
    for (const verb of POINT_VERBS) expect(first!.toolNames).toContain(verb);
    expect(first!.system).toContain('use the point tools only for a target the screen does not list');
    expect(first!.system).toContain('take a screenshot before guessing a point');
  });

  it('attaches the screenshot to the tool result as an image, then taps the bare point it named', () => {
    expect(resultByTitle(outcome, 'taps a canvas pin the tree does not list').status).toBe('passed');
    const step = stepOf('taps a canvas pin the tree does not list');
    const actions = step.events.filter((event) => event.kind === 'engine');
    expect(actions.map((event) => event.name)).toEqual(['tapAt']);
    expect(actions[0]!.detail).toBe('tap the point (300, 60)');
    // No harness-made model call: the pixels went to the act model itself.
    expect(step.metrics!.modelCalls).toBe(3);
    expect(step.visionInput).toBe(true);
    expect(step.visionOnly).toBeUndefined();
    expect(step.metrics!.pixelBytes).toBeGreaterThan(0);
    const [, second, third] = turnsOf('pick the red pin');
    // The screenshot result is content: the screen text plus an image file part.
    expect(second!.lastToolResult).toContain('"type":"file"');
    expect(second!.lastToolResult).toContain('"mediaType":"image/png"');
    expect(second!.lastToolResult).toContain('Point coordinates (tap_at and the other _at verbs) are pixels of this image');
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

  it('answers a point verb before any screenshot with the line to read, spending no action', () => {
    for (const [title, verb] of [
      ['asks for a screenshot before tapping a point', 'tap_at'],
      ['asks for a screenshot before typing at a point', 'type_at'],
    ] as const) {
      const result = resultByTitle(outcome, title);
      expect(result.status).toBe('failed');
      expect(result.attempts.at(-1)!.error?.message).toContain(
        `No screenshot has been taken in this step: ${verb} coordinates are pixels of the latest screenshot`,
      );
      const step = stepOf(title);
      expect(step.events.filter((event) => event.kind === 'engine')).toHaveLength(0);
      expect(step.metrics!.actionSteps).toBe(0);
    }
  });

  it('leaves every pixel verb out of the vocabulary once a secret was filled', () => {
    expect(resultByTitle(outcome, 'offers no pixel verbs after a secret fill').status).toBe('passed');
    const [first] = turnsOf('note the page');
    for (const verb of POINT_VERBS) expect(first!.toolNames).not.toContain(verb);
    expect(first!.toolNames).toContain('tap');
    expect(first!.toolNames).toContain('type');
  });

  it('types, presses, and selects through points, acting on the listed control by id underneath', () => {
    expect(resultByTitle(outcome, 'types, presses, and selects through points').status).toBe('passed');
    const step = stepOf('types, presses, and selects through points');
    const actions = step.events.filter((event) => event.kind === 'engine');
    expect(actions.map((event) => event.name)).toEqual(['type', 'press', 'selectOption']);
    expect(actions[0]!.detail).toBe('type "hello" into textbox "Note"');
    expect(actions[1]!.detail).toBe('press "Enter" on textbox "Note"');
    expect(actions[2]!.detail).toBe('select "warm" in combobox "Tint"');
    const [, , third, fourth, fifth] = turnsOf('write a note');
    // Tool results are JSON-encoded content, so quoted names read escaped. The
    // result names the control by the line the model holds, id included.
    expect(third!.lastToolResult).toMatch(/Typed into #\S+ textbox \\"Note\\", the control at \(100, 315\)\./);
    expect(fourth!.lastToolResult).toMatch(/Pressed Enter on #\S+ textbox \\"Note\\"[^,]*, the control at \(100, 315\)\./);
    expect(fifth!.lastToolResult).toMatch(/Selected \\"warm\\" in #\S+ combobox \\"Tint\\"[^,]*, the control at \(100, 355\)\./);
  });

  it('reports a point with nothing selectable under it as an action failure the model can read', () => {
    expect(resultByTitle(outcome, 'refuses a point with nothing selectable under it').status).toBe('failed');
    const [, , third] = turnsOf('select on the map');
    // The lead echoes the model's image coordinates; the hit summary speaks in viewport pixels.
    expect(third!.lastToolResult).toContain(
      'select_at (30, 30) failed: nothing the screen lists is at (50, 50); select_at needs a control the screen lists.',
    );
    const step = stepOf('refuses a point with nothing selectable under it');
    expect(step.events.filter((event) => event.kind === 'engine')).toHaveLength(0);
    expect(step.metrics!.actionSteps).toBe(0);
  });

  it('taps a drawn field to focus it and types through the keyboard, then presses Enter on the focused field', () => {
    expect(resultByTitle(outcome, 'types into a drawn field through the keyboard').status).toBe('passed');
    const step = stepOf('types into a drawn field through the keyboard');
    const actions = step.events.filter((event) => event.kind === 'engine');
    expect(actions.map((event) => event.name)).toEqual(['tapAt', 'typeText', 'pressKey']);
    expect(actions[1]!.detail).toBe('type "hi" into the focused field');
    expect(actions[2]!.detail).toBe('press "Enter" on the focused field');
    const [, , third, fourth] = turnsOf('type hi into the drawn field');
    expect(third!.lastToolResult).toContain('Typed into the field at (120, 60) (tapped to focus it; nothing the screen lists is at (200, 100)).');
    expect(fourth!.lastToolResult).toContain('Pressed Enter on the focused field.');
  });

  it('offers type and press without a target, typing into the focused drawn field', () => {
    expect(resultByTitle(outcome, 'types into a focused drawn field with type and press without a target').status).toBe('passed');
    const step = stepOf('types into a focused drawn field with type and press without a target');
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
    // The fill was refused, so the node was tapped to hold focus and typed into through the keyboard.
    expect(actions.map((event) => `${event.name}:${event.status}`)).toEqual(['type:failed', 'tap:passed', 'typeText:passed', 'press:passed']);
    const [, second] = turnsOf('type yo into the pad');
    expect(second!.lastToolResult).toMatch(/#\S+ is not an input; tapped it to focus it and typed through the keyboard\./);
    // The pad's text is nowhere in the tree, so the unchanged listing is not read as the typing having failed.
    expect(second!.lastToolResult).toContain(
      "The tree does not list this node's text, so an unchanged listing says nothing about the typing: verify it through the app's reaction or a screenshot.",
    );
    expect(second!.lastToolResult).not.toContain('had no visible effect');
  });

  it('refuses focused typing into nothing editable, as an action failure the model reads', () => {
    expect(resultByTitle(outcome, 'refuses focused typing when nothing editable has focus').status).toBe('failed');
    const step = stepOf('refuses focused typing when nothing editable has focus');
    // The engine refused before any keystroke: the action was reserved, not committed.
    expect(step.events.filter((event) => event.kind === 'engine' && event.status === 'passed')).toHaveLength(0);
    const [, second] = turnsOf('type blind');
    expect(second!.lastToolResult).toContain('nothing that takes keystrokes has focus: the typed text would reach no field');
  });

  it('counts failing point verbs toward the failure streak: a warning at three, a forced verdict at five', () => {
    expect(resultByTitle(outcome, 'stops a streak of failing point verbs').status).toBe('failed');
    const step = stepOf('stops a streak of failing point verbs');
    expect(step.metrics!.modelCalls).toBeLessThanOrEqual(8);
    const turns = turnsOf('pick options off the empty map margin');
    // Every refusal reads `select_at (x, y) failed: ...` beside a fresh screenshot: pixel mode held.
    expect(turns[2]!.lastToolResult).toContain('select_at (400, 190) failed: nothing the screen lists is at');
    expect(turns[2]!.lastToolResult).toContain('"type":"file"');
    expect(turns.some((turn) => turn.lastPrompt.includes('the last 3 actions failed in a row'))).toBe(true);
    const last = turns.at(-1)!;
    expect(last.toolNames).toEqual(['complete_step']);
    expect(last.lastPrompt).toContain('Loop guard: the last 5 actions failed in a row');
  });

  it('reports a moved screenshot under an unchanged listing, and blames the control only when the image stood still too', () => {
    expect(resultByTitle(outcome, 'reads a repaint the tree cannot list off the screenshot').status).toBe('passed');
    const turns = turnsOf('tap the map twice, then the margin twice');
    // The first miss changed the listed status text; the second repeated it, and only the drawn tap count moved.
    expect(turns[3]!.lastToolResult).toMatch(/changed #\S+ status \\"Hit\\" text=\\"miss at 100,100\\"/);
    expect(turns[4]!.lastToolResult).toContain('listed nodes unchanged; the screenshot changed');
    expect(turns[4]!.lastToolResult).not.toContain('had no visible effect');
    expect(turns[4]!.lastToolResult).toContain('"type":"file"');
    // The second margin tap changed neither the listing nor a pixel: the same PNG, so the tap is blamed as before.
    expect(turns[6]!.lastToolResult).toContain('had no visible effect');
    expect(turns[6]!.lastToolResult).not.toContain('the screenshot changed');
    expect(turns[6]!.lastToolResult).toContain('"type":"file"');
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
        'tests/race.e2e.ts': `import { test, expect } from 'e2e';

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

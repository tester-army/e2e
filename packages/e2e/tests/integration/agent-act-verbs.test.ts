/**
 * The grammar verbs beyond tap and type: hover (by id and at a point), the
 * tap variants, drag, check, upload, scroll_to, and back. The scripted model
 * calls each tool once against the gestures page; under test is the runner
 * half: each verb reaches the engine as its own action, is recorded with a
 * readable summary, an upload is authorized against the project root before
 * anything runs, and a recorded flow of these verbs replays zero-turn from
 * the trace cache on the next run.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { installFakeLoopModel, loopCalls, nodeIdFor, type LoopCall } from '../helpers/fake-loop-model.ts';
import { createProject, resultByTitle, runExisting, runProject, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';

const SUITE = `import { test, expect } from 'e2e';

test.beforeEach(async ({ app }) => {
  await app.open('/gestures');
});

test('hovers the menu trigger and taps what it reveals', async ({ agent, screen }) => {
  await agent.act('hover the account menu and redeem the voucher');
  await expect(screen.getByRole('status', { name: 'Gesture state' })).toHaveText('redeemed');
});

test('right-clicks a file and renames it through the context menu', async ({ agent, screen }) => {
  await agent.act('right-click report.pdf and rename it');
  await expect(screen.getByRole('status', { name: 'Gesture state' })).toHaveText('renamed');
});

test('double-taps and long-presses', async ({ agent, screen }) => {
  await agent.act('double-tap the twice button, then long-press hold me');
  await expect(screen.getByRole('status', { name: 'Gesture state' })).toHaveText('long-pressed');
});

test('drags the card onto the done column', async ({ agent, screen }) => {
  await agent.act('drag the design review card to the done column');
  await expect(screen.getByRole('status', { name: 'Gesture state' })).toHaveText('Design review is done');
});

test('checks the box and leaves a checked box alone', async ({ agent, screen }) => {
  await agent.act('agree to the terms, then make sure the box stays checked');
  await expect(screen.getByLabel('Agree to terms')).toBeChecked();
});

test('uploads a project file', async ({ agent, screen }) => {
  await agent.act('attach the fixture file');
  await expect(screen.getByRole('status', { name: 'Gesture state' })).toHaveText('attached: attachment.txt');
});

test('refuses a hidden file', async ({ agent }) => {
  await agent.act('attach the env file');
});

test('refuses a file outside the project', async ({ agent }) => {
  await agent.act('attach a file from outside the project');
});

test('scrolls a listed node into view', async ({ agent, screen }) => {
  await agent.act('scroll to the footnote');
  await expect(screen.getByLabel('Footnote state')).toHaveText('in view');
});

test('opens a page and comes back', async ({ agent, screen }) => {
  await agent.act('open the about page and come back');
  await expect(screen.getByRole('heading', { name: 'Gestures' })).toBeVisible();
});

test('hovers a bare point in the screenshot', async ({ agent, screen }) => {
  await agent.act('hover the corner to reveal the redeem button');
  await expect(screen.getByRole('status', { name: 'Gesture state' })).toHaveText('redeemed');
});
`;

/** The flows the replay pass records on the first run and replays on the second. */
const REPLAY_SUITE = `import { test, expect } from 'e2e';

test.beforeEach(async ({ app }) => {
  await app.open('/gestures');
});

test('hover then tap', async ({ agent, screen }) => {
  await agent.act('hover the account menu and redeem the voucher');
  await expect(screen.getByRole('status', { name: 'Gesture state' })).toHaveText('redeemed');
});

test('drag', async ({ agent, screen }) => {
  await agent.act('drag the design review card to the done column');
  await expect(screen.getByRole('status', { name: 'Gesture state' })).toHaveText('Design review is done');
});

test('check', async ({ agent, screen }) => {
  await agent.act('agree to the terms, then make sure the box stays checked');
  await expect(screen.getByRole('status', { name: 'Gesture state' })).toHaveText('agreed: true');
});

test('upload', async ({ agent, screen }) => {
  await agent.act('attach the fixture file');
  await expect(screen.getByRole('status', { name: 'Gesture state' })).toHaveText('attached: attachment.txt');
});

test('scroll to', async ({ agent, screen }) => {
  await agent.act('scroll to the footnote');
  await expect(screen.getByLabel('Footnote state')).toHaveText('in view');
});

test('back', async ({ agent, screen }) => {
  await agent.act('open the about page and come back');
  await expect(screen.getByRole('heading', { name: 'Gestures' })).toBeVisible();
});
`;

/** The project files beside the suite: one uploadable fixture and one hidden file the policy must refuse. */
const PROJECT_FILES = {
  'fixtures/attachment.txt': 'attached\n',
  '.env': 'SECRET=never-uploaded\n',
};

/** The act model: one grammar tool per turn, then a verdict carrying the last result. */
function actModel(call: LoopCall) {
  const conclude = (status: 'passed' | 'failed') => [
    { toolName: 'complete_step', input: { status, summary: call.lastToolResult.slice(0, 1_500) || 'done' } },
  ];
  const calls = call.toolResults.length;
  const on = (pattern: RegExp) => nodeIdFor(call.prompt, pattern);
  const revealed = (pattern: RegExp) => nodeIdFor(call.lastToolResult, pattern);
  if (call.prompt.includes('hover the account menu')) {
    if (calls === 0) return [{ toolName: 'hover', input: { target: on(/"Account"/) } }];
    if (calls === 1) return [{ toolName: 'tap', input: { target: revealed(/button "Redeem"/) } }];
    return conclude('passed');
  }
  if (call.prompt.includes('right-click report.pdf')) {
    if (calls === 0) return [{ toolName: 'right_click', input: { target: on(/"report\.pdf"/) } }];
    if (calls === 1) return [{ toolName: 'tap', input: { target: revealed(/"Rename"/) } }];
    return conclude('passed');
  }
  if (call.prompt.includes('double-tap the twice button')) {
    if (calls === 0) return [{ toolName: 'double_tap', input: { target: on(/button "Tap me twice"/) } }];
    if (calls === 1) return [{ toolName: 'long_press', input: { target: on(/button "Hold me"/) } }];
    return conclude('passed');
  }
  if (call.prompt.includes('drag the design review card')) {
    if (calls === 0) return [{ toolName: 'drag', input: { target: on(/"Design review"/), to: on(/"Done column"/) } }];
    return conclude('passed');
  }
  if (call.prompt.includes('agree to the terms')) {
    if (calls <= 1) return [{ toolName: 'check', input: { target: on(/checkbox "Agree to terms"/), checked: true } }];
    return conclude('passed');
  }
  if (call.prompt.includes('attach the fixture file')) {
    if (calls === 0) return [{ toolName: 'upload', input: { target: on(/"Attachment"/), files: ['fixtures/attachment.txt'] } }];
    return conclude('passed');
  }
  if (call.prompt.includes('attach the env file')) {
    if (calls === 0) return [{ toolName: 'upload', input: { target: on(/"Attachment"/), files: ['.env'] } }];
    return conclude('failed');
  }
  if (call.prompt.includes('attach a file from outside')) {
    if (calls === 0) return [{ toolName: 'upload', input: { target: on(/"Attachment"/), files: ['../outside.txt'] } }];
    return conclude('failed');
  }
  if (call.prompt.includes('scroll to the footnote')) {
    if (calls === 0) return [{ toolName: 'scroll_to', input: { target: on(/"Footnote"/) } }];
    return conclude('passed');
  }
  if (call.prompt.includes('open the about page')) {
    if (calls === 0) return [{ toolName: 'tap', input: { target: on(/link "About"/) } }];
    if (calls === 1) return [{ toolName: 'back', input: {} }];
    return conclude('passed');
  }
  if (call.prompt.includes('hover the corner')) {
    // The trigger is pinned at CSS (40..240, 40..70); its center (140, 55) is image (84, 33) at 0.6 image pixels per CSS pixel.
    if (calls === 0) return [{ toolName: 'screenshot', input: {} }];
    if (calls === 1) return [{ toolName: 'hover_at', input: { x: 84, y: 33 } }];
    // In pixel mode the result is one JSON-encoded line, quotes escaped: the id is read right before the button's line.
    if (calls === 2) return [{ toolName: 'tap', input: { target: /#(\S+) button \\"Redeem\\"/.exec(call.lastToolResult)![1]! } }];
    return conclude('passed');
  }
  return conclude('passed');
}

const VERB_TOOLS = ['hover', 'hover_at', 'double_tap', 'long_press', 'right_click', 'drag', 'check', 'upload', 'scroll_to', 'back'];

describe('agent.act grammar verbs', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    const model = installFakeLoopModel(actModel);
    const run = await runProject(
      { 'tests/verbs.e2e.ts': SUITE, ...PROJECT_FILES },
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agents: { default: { model } } } },
    );
    outcome = run.outcome;
    project = run.project;
  }, 240_000);

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
  const engineEvents = (title: string) => stepOf(title).events.filter((event) => event.kind === 'engine');
  const turnsOf = (instruction: string) => loopCalls.filter((call) => call.prompt.includes(instruction));

  it('offers every verb the browser engine declares, and the rules say what takes a plain tap', () => {
    const [first] = turnsOf('hover the account menu');
    for (const tool of VERB_TOOLS) expect(first!.toolNames).toContain(tool);
    expect(first!.system).toContain('hover for what opens on the pointer resting on it');
    expect(first!.system).toContain('tap is the gesture for a button, link, menu item, tab, checkbox, row, or field');
  });

  it('hovers by id, reports the control the hover revealed, and records the hover', () => {
    expect(resultByTitle(outcome, 'hovers the menu trigger and taps what it reveals').status).toBe('passed');
    const actions = engineEvents('hovers the menu trigger and taps what it reveals');
    expect(actions.map((event) => `${event.name}:${event.status}`)).toEqual(['hover:passed', 'tap:passed']);
    expect(actions[0]!.detail).toMatch(/^hover over \S+ "Account"$/);
    expect(actions[1]!.detail).toBe('tap button "Redeem"');
    const [, second] = turnsOf('hover the account menu');
    expect(second!.lastToolResult).toMatch(/^Hovered over #\S+\./);
    expect(second!.lastToolResult).toMatch(/added #\S+ button "Redeem"/);
  });

  it('dispatches the tap variants as their own engine actions', () => {
    expect(resultByTitle(outcome, 'right-clicks a file and renames it through the context menu').status).toBe('passed');
    const menu = engineEvents('right-clicks a file and renames it through the context menu');
    expect(menu.map((event) => event.name)).toEqual(['secondaryTap', 'tap']);
    expect(menu[0]!.detail).toMatch(/^secondary-tap \S+ "report\.pdf"$/);
    expect(turnsOf('right-click report.pdf')[1]!.lastToolResult).toMatch(/^Right-clicked #\S+\./);

    expect(resultByTitle(outcome, 'double-taps and long-presses').status).toBe('passed');
    const gestures = engineEvents('double-taps and long-presses');
    expect(gestures.map((event) => event.name)).toEqual(['doubleTap', 'longPress']);
    expect(gestures[0]!.detail).toBe('double-tap button "Tap me twice"');
    expect(gestures[1]!.detail).toBe('long-press button "Hold me"');
  });

  it('drags one node onto another and records both ends', () => {
    expect(resultByTitle(outcome, 'drags the card onto the done column').status).toBe('passed');
    const actions = engineEvents('drags the card onto the done column');
    expect(actions.map((event) => event.name)).toEqual(['dragTo']);
    expect(actions[0]!.detail).toMatch(/^drag \S+ "Design review" to \S+ "Done column"$/);
    expect(turnsOf('drag the design review card')[1]!.lastToolResult).toMatch(/^Dragged #\S+ to #\S+\./);
  });

  it('sets a checkbox state and leaves it alone when it already holds', () => {
    expect(resultByTitle(outcome, 'checks the box and leaves a checked box alone').status).toBe('passed');
    const actions = engineEvents('checks the box and leaves a checked box alone');
    expect(actions.map((event) => `${event.name}:${event.status}`)).toEqual(['check:passed', 'check:passed']);
    expect(actions[0]!.detail).toBe('check checkbox "Agree to terms"');
    const [, second, third] = turnsOf('agree to the terms');
    expect(second!.lastToolResult).toMatch(/changed #\S+ status "Gesture state" text="agreed: true"/);
    // The second check flipped nothing: the screen stood still, and the result says so.
    expect(third!.lastToolResult).toContain('had no visible effect');
  });

  it('uploads a project-relative file, recording the path as given and the policy decision', () => {
    expect(resultByTitle(outcome, 'uploads a project file').status).toBe('passed');
    const step = stepOf('uploads a project file');
    const actions = step.events.filter((event) => event.kind === 'engine');
    expect(actions.map((event) => event.name)).toEqual(['setInputFiles']);
    expect(actions[0]!.detail).toMatch(/^upload "fixtures\/attachment\.txt" to \S+ "Attachment"$/);
    expect(step.events.filter((event) => event.kind === 'policy')).toEqual([
      expect.objectContaining({ name: 'upload-path', decision: 'allowed' }),
    ]);
    expect(turnsOf('attach the fixture file')[1]!.lastToolResult).toMatch(/^Uploaded "fixtures\/attachment\.txt" to #\S+\./);
  });

  it('refuses a hidden file and a path outside the project before any engine action, as POLICY_DENIED', () => {
    for (const [title, instruction, message] of [
      ['refuses a hidden file', 'attach the env file', '".env" is a hidden file or sits under a hidden directory; those are never uploaded'],
      ['refuses a file outside the project', 'attach a file from outside', '"../outside.txt" is outside the project root; only files inside the project can be uploaded'],
    ] as const) {
      expect(resultByTitle(outcome, title).status).toBe('failed');
      const step = stepOf(title);
      expect(step.events.filter((event) => event.kind === 'engine')).toHaveLength(0);
      expect(step.metrics!.actionSteps).toBe(0);
      expect(step.events.filter((event) => event.kind === 'policy')).toEqual([
        expect.objectContaining({ name: 'upload-path', decision: 'denied', code: 'POLICY_DENIED' }),
      ]);
      expect(turnsOf(instruction)[1]!.lastToolResult).toContain(`failed: ${message}`);
    }
  });

  it('scrolls a listed node into view as one action', () => {
    expect(resultByTitle(outcome, 'scrolls a listed node into view').status).toBe('passed');
    const actions = engineEvents('scrolls a listed node into view');
    expect(actions.map((event) => event.name)).toEqual(['scrollIntoView']);
    expect(actions[0]!.detail).toMatch(/^scroll \S+ "Footnote" into view$/);
    expect(turnsOf('scroll to the footnote')[1]!.lastToolResult).toMatch(/^Scrolled #\S+ into view\./);
  });

  it('goes back through the engine session and reports the screen it returned to', () => {
    expect(resultByTitle(outcome, 'opens a page and comes back').status).toBe('passed');
    const actions = engineEvents('opens a page and comes back');
    expect(actions.map((event) => event.name)).toEqual(['tap', 'back']);
    expect(actions[1]!.detail).toBe('navigate back');
    const [, second, third] = turnsOf('open the about page');
    expect(second!.lastToolResult).toMatch(/heading "About"/);
    expect(third!.lastToolResult).toMatch(/^Navigated back\./);
    expect(third!.lastToolResult).toMatch(/heading "Gestures"/);
  });

  it('hovers a bare point through the engine when nothing listed is a control there', () => {
    expect(resultByTitle(outcome, 'hovers a bare point in the screenshot').status).toBe('passed');
    const actions = engineEvents('hovers a bare point in the screenshot');
    expect(actions.map((event) => event.name)).toEqual(['hoverAt', 'tap']);
    expect(actions[0]!.detail).toMatch(/^hover over the point \(140, 55\)/);
    const [, , third] = turnsOf('hover the corner');
    expect(third!.lastToolResult).toContain('Hovered over the point (140, 55); no listed control is there');
    expect(third!.lastToolResult).toMatch(/added #\S+ button \\"Redeem\\"/);
  });
});

describe('agent.act grammar verbs: record then zero-turn replay', () => {
  let app: FixtureApp;
  let project: FixtureProject;
  let firstRun: RunOutcome;
  let secondRun: RunOutcome;
  let secondRunModelCalls = 0;

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ 'tests/replay.e2e.ts': REPLAY_SUITE, ...PROJECT_FILES });
    const options = (model: ReturnType<typeof installFakeLoopModel>) => ({
      appUrl: app.url,
      config: { tests: 'tests/**/*.e2e.ts', agents: { default: { model } }, cache: 'read-write' as const },
    });
    firstRun = await runExisting(project, options(installFakeLoopModel(actModel)));
    secondRun = await runExisting(
      project,
      options(
        installFakeLoopModel((call) => {
          secondRunModelCalls += 1;
          return actModel(call);
        }),
      ),
    );
  }, 300_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  const actSteps = (run: RunOutcome) =>
    run.results.map((result) => {
      const step = result.attempts.at(-1)!.steps.find((candidate) => candidate.api === 'agent.act');
      if (step === undefined) throw new Error(`no agent.act step in "${result.test.title}"`);
      return [result.test.title, step] as const;
    });

  it('records every verb on the first run', () => {
    expect(firstRun.exitCode).toBe(0);
    for (const [title, step] of actSteps(firstRun)) {
      expect(step.cache, title).toMatchObject({ mode: 'missed', reason: 'no-entry' });
    }
  });

  it('replays hover, drag, check, upload, scroll into view, and back without a model call', () => {
    expect(secondRun.exitCode).toBe(0);
    expect(secondRunModelCalls).toBe(0);
    for (const [title, step] of actSteps(secondRun)) {
      expect(step.cache, title).toMatchObject({ mode: 'self-finalized' });
      expect(step.metrics!.modelCalls, title).toBe(0);
    }
    const replayed = new Map(actSteps(secondRun));
    expect(replayed.get('hover then tap')!.events.filter((event) => event.kind === 'engine').map((event) => event.name)).toEqual(['hover', 'tap']);
    expect(replayed.get('drag')!.events.filter((event) => event.kind === 'engine').map((event) => event.name)).toEqual(['dragTo']);
    expect(replayed.get('upload')!.events.filter((event) => event.kind === 'policy')).toEqual([
      expect.objectContaining({ name: 'upload-path', decision: 'allowed' }),
    ]);
    expect(replayed.get('back')!.events.filter((event) => event.kind === 'engine').map((event) => event.name)).toEqual(['tap', 'back']);
  });
});

/**
 * The grammar verbs beyond tap and type: hover (by id and at a point), the
 * tap variants, drag, check, upload, scroll_to, and back. Each flow is one
 * row: the instruction, the scripted model that answers it, and the check
 * that pins its outcome. The scripted model calls each tool once against the
 * gestures page; under test is the runner half: each verb reaches the engine
 * as its own action, is recorded with a readable summary, an upload is
 * authorized against the project root before anything runs, and a recorded
 * flow of these verbs replays zero-turn from the trace cache on the next run.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { imagePointFor, installFakeLoopModel, loopCalls, nodeIdFor, type LoopCall, type LoopToolCall } from '../helpers/fake-loop-model.ts';
import { createProject, resultByTitle, runExisting, runProject, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';

/** One agentic flow: what the test asks, how the scripted model answers, and the locator check that decides it. */
interface Flow {
  readonly title: string;
  readonly instruction: string;
  /** The test body's check after the step, as source; empty for a flow whose step is expected to fail. */
  readonly check: string;
  /** Whether the replay pass records and replays this flow too. */
  readonly replays?: true;
  /** The tool calls for the turn with `calls` results so far; undefined concludes the step. */
  readonly script: (calls: number, call: LoopCall) => readonly LoopToolCall[] | undefined;
  readonly verdict?: 'failed';
}

/** The center of the hover trigger, which the gestures page pins at CSS (40..240, 40..70). */
const TRIGGER_CENTER = { x: 140, y: 55 };

const FLOWS: readonly Flow[] = [
  {
    title: 'hovers the menu trigger and taps what it reveals',
    instruction: 'hover the account menu and redeem the voucher',
    check: `await expect(screen.getByRole('status', { name: 'Gesture state' })).toHaveText('redeemed');`,
    replays: true,
    script: (calls, call) => {
      if (calls === 0) return [{ toolName: 'hover', input: { target: nodeIdFor(call.prompt, /"Account"/) } }];
      if (calls === 1) return [{ toolName: 'tap', input: { target: nodeIdFor(call.lastToolResult, /button "Redeem"/) } }];
      return undefined;
    },
  },
  {
    title: 'right-clicks a file and renames it through the context menu',
    instruction: 'right-click report.pdf and rename it',
    check: `await expect(screen.getByRole('status', { name: 'Gesture state' })).toHaveText('renamed');`,
    script: (calls, call) => {
      if (calls === 0) return [{ toolName: 'right_click', input: { target: nodeIdFor(call.prompt, /"report\.pdf"/) } }];
      if (calls === 1) return [{ toolName: 'tap', input: { target: nodeIdFor(call.lastToolResult, /"Rename"/) } }];
      return undefined;
    },
  },
  {
    title: 'double-taps and long-presses',
    instruction: 'double-tap the twice button, then long-press hold me',
    check: `await expect(screen.getByRole('status', { name: 'Gesture state' })).toHaveText('long-pressed');`,
    script: (calls, call) => {
      if (calls === 0) return [{ toolName: 'double_tap', input: { target: nodeIdFor(call.prompt, /button "Tap me twice"/) } }];
      if (calls === 1) return [{ toolName: 'long_press', input: { target: nodeIdFor(call.prompt, /button "Hold me"/) } }];
      return undefined;
    },
  },
  {
    title: 'drags the card onto the done column',
    instruction: 'drag the design review card to the done column',
    check: `await expect(screen.getByRole('status', { name: 'Gesture state' })).toHaveText('Design review is done');`,
    replays: true,
    script: (calls, call) =>
      calls === 0
        ? [{ toolName: 'drag', input: { target: nodeIdFor(call.prompt, /"Design review"/), to: nodeIdFor(call.prompt, /"Done column"/) } }]
        : undefined,
  },
  {
    title: 'checks the box and leaves a checked box alone',
    instruction: 'agree to the terms, then make sure the box stays checked',
    check: `await expect(screen.getByLabel('Agree to terms')).toBeChecked();
  await expect(screen.getByRole('status', { name: 'Gesture state' })).toHaveText('agreed: true');`,
    replays: true,
    // The same check twice: the second finds the box already checked and flips nothing.
    script: (calls, call) =>
      calls <= 1 ? [{ toolName: 'check', input: { target: nodeIdFor(call.prompt, /checkbox "Agree to terms"/), checked: true } }] : undefined,
  },
  {
    title: 'uploads a project file',
    instruction: 'attach the fixture file',
    check: `await expect(screen.getByRole('status', { name: 'Gesture state' })).toHaveText('attached: attachment.txt');`,
    replays: true,
    script: (calls, call) =>
      calls === 0 ? [{ toolName: 'upload', input: { target: nodeIdFor(call.prompt, /"Attachment"/), files: ['fixtures/attachment.txt'] } }] : undefined,
  },
  {
    title: 'refuses a hidden file',
    instruction: 'attach the env file',
    check: '',
    verdict: 'failed',
    script: (calls, call) => (calls === 0 ? [{ toolName: 'upload', input: { target: nodeIdFor(call.prompt, /"Attachment"/), files: ['.env'] } }] : undefined),
  },
  {
    title: 'refuses a file outside the project',
    instruction: 'attach a file from outside the project',
    check: '',
    verdict: 'failed',
    script: (calls, call) =>
      calls === 0 ? [{ toolName: 'upload', input: { target: nodeIdFor(call.prompt, /"Attachment"/), files: ['../outside.txt'] } }] : undefined,
  },
  {
    title: 'scrolls a listed node into view',
    instruction: 'scroll to the footnote',
    check: `await expect(screen.getByLabel('Footnote state')).toHaveText('in view');`,
    replays: true,
    script: (calls, call) => (calls === 0 ? [{ toolName: 'scroll_to', input: { target: nodeIdFor(call.prompt, /"Footnote"/) } }] : undefined),
  },
  {
    title: 'pages a windowed list to a row it has not rendered',
    instruction: 'scroll the ledger to the golden row',
    check: `await expect(screen.getByLabel('Ledger state')).toHaveText('golden in view');`,
    replays: true,
    script: (calls, call) =>
      calls === 0 ? [{ toolName: 'scroll_to', input: { text: 'Row 333', target: nodeIdFor(call.prompt, /list "Ledger"/) } }] : undefined,
  },
  {
    title: 'selects one word with a repeated press and sees the selection',
    instruction: 'select the last word of the memo',
    check: `await expect(screen.getByRole('status', { name: 'Gesture state' })).toHaveText('selected: approved');`,
    replays: true,
    script: (calls, call) => {
      const memo = nodeIdFor(call.prompt, /textbox "Memo"/);
      if (calls === 0) return [{ toolName: 'tap', input: { target: memo } }];
      if (calls === 1) return [{ toolName: 'press', input: { target: memo, key: 'Shift+ArrowLeft', times: 8 } }];
      return undefined;
    },
  },
  {
    title: 'tabs from the terms checkbox to the memo with one repeated press',
    instruction: 'tab from the terms checkbox to the memo',
    // Tabbing into a text input selects its contents, which the page's select listener echoes.
    check: `await expect(screen.getByRole('status', { name: 'Gesture state' })).toHaveText('selected: release approved');`,
    replays: true,
    script: (calls, call) =>
      calls === 0 ? [{ toolName: 'press', input: { target: nodeIdFor(call.prompt, /checkbox "Agree to terms"/), key: 'Tab', times: 2 } }] : undefined,
  },
  {
    title: 'opens a page and comes back',
    instruction: 'open the about page and come back',
    check: `await expect(screen.getByRole('heading', { name: 'Gestures' })).toBeVisible();`,
    replays: true,
    script: (calls, call) => {
      if (calls === 0) return [{ toolName: 'tap', input: { target: nodeIdFor(call.prompt, /link "About"/) } }];
      if (calls === 1) return [{ toolName: 'back', input: {} }];
      return undefined;
    },
  },
  {
    title: 'hovers a bare point in the screenshot',
    instruction: 'hover the corner to reveal the redeem button',
    check: `await expect(screen.getByRole('status', { name: 'Gesture state' })).toHaveText('redeemed');`,
    script: (calls, call) => {
      if (calls === 0) return [{ toolName: 'screenshot', input: {} }];
      if (calls === 1) return [{ toolName: 'hover_at', input: imagePointFor(call.lastToolResult, TRIGGER_CENTER) }];
      if (calls === 2) return [{ toolName: 'tap', input: { target: nodeIdFor(call.lastToolResult, /button "Redeem"/) } }];
      return undefined;
    },
  },
];

/** The suite source for a set of flows: every test opens the gestures page, runs its instruction, and pins the outcome. */
function suiteOf(flows: readonly Flow[]): string {
  const tests = flows.map(
    (flow) => `test(${JSON.stringify(flow.title)}, async ({ agent, screen }) => {
  await agent.act(${JSON.stringify(flow.instruction)});
  ${flow.check}
});`,
  );
  return `import { test, expect } from 'e2e';

test.beforeEach(async ({ app }) => {
  await app.open('/gestures');
});

${tests.join('\n\n')}
`;
}

/** The project files beside the suite: one uploadable fixture and one hidden file the policy must refuse. */
const PROJECT_FILES = {
  'fixtures/attachment.txt': 'attached\n',
  '.env': 'SECRET=never-uploaded\n',
};

/** The act model: the flow's script for the turn, then a verdict carrying the last result. */
function actModel(call: LoopCall) {
  const flow = FLOWS.find((candidate) => call.prompt.includes(candidate.instruction));
  const scripted = flow?.script(call.toolResults.length, call);
  if (scripted !== undefined) return scripted;
  return [{ toolName: 'complete_step', input: { status: flow?.verdict ?? 'passed', summary: call.lastToolResult.slice(0, 1_500) || 'done' } }];
}

const VERB_TOOLS = ['hover', 'hover_at', 'double_tap', 'long_press', 'right_click', 'drag', 'check', 'upload', 'scroll_to', 'back'];

/** The `agent.act` step of one test in a run. */
function actStepOf(outcome: RunOutcome, title: string) {
  const step = resultByTitle(outcome, title).attempts.at(-1)!.steps.find((candidate) => candidate.api === 'agent.act');
  if (step === undefined) throw new Error(`no agent.act step in "${title}"`);
  return step;
}

describe('agent.act grammar verbs', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    const model = installFakeLoopModel(actModel);
    const run = await runProject(
      { 'tests/verbs.e2e.ts': suiteOf(FLOWS), ...PROJECT_FILES },
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agents: { default: { model } } } },
    );
    outcome = run.outcome;
    project = run.project;
  }, 240_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  const stepOf = (title: string) => actStepOf(outcome, title);
  const engineEvents = (title: string) => stepOf(title).events.filter((event) => event.kind === 'engine');
  const turnsOf = (instruction: string) => loopCalls.filter((call) => call.prompt.includes(instruction));

  it('offers every verb the browser engine declares', () => {
    const [first] = turnsOf('hover the account menu');
    for (const tool of VERB_TOOLS) expect(first!.toolNames).toContain(tool);
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
    // The second check flipped nothing: the listing stood still, and the result says so without blaming the control.
    expect(third!.lastToolResult).toContain('No listed node changed');
    expect(third!.lastToolResult).not.toContain('had no visible effect');
  });

  it('uploads a project-relative file, recording the path as given and the policy decision', () => {
    expect(resultByTitle(outcome, 'uploads a project file').status).toBe('passed');
    const step = stepOf('uploads a project file');
    const actions = step.events.filter((event) => event.kind === 'engine');
    expect(actions.map((event) => event.name)).toEqual(['setInputFiles']);
    expect(actions[0]!.detail).toMatch(/^upload "fixtures\/attachment\.txt" to \S+ "Attachment"$/);
    expect(step.events.filter((event) => event.kind === 'policy')).toEqual([expect.objectContaining({ name: 'upload.path', decision: 'allowed' })]);
    expect(turnsOf('attach the fixture file')[1]!.lastToolResult).toMatch(/^Uploaded "fixtures\/attachment\.txt" to #\S+\./);
  });

  it('refuses a hidden file and a path outside the project before any engine action, as POLICY_DENIED', () => {
    for (const [title, instruction, path] of [
      ['refuses a hidden file', 'attach the env file', '.env'],
      ['refuses a file outside the project', 'attach a file from outside', '../outside.txt'],
    ] as const) {
      expect(resultByTitle(outcome, title).status).toBe('failed');
      const step = stepOf(title);
      expect(step.events.filter((event) => event.kind === 'engine')).toHaveLength(0);
      expect(step.metrics!.actionSteps).toBe(0);
      expect(step.events.filter((event) => event.kind === 'policy')).toEqual([
        expect.objectContaining({ name: 'upload.path', decision: 'denied', code: 'POLICY_DENIED' }),
      ]);
      // The refusal reaches the model as the action's failure, led by the attempt and the code, naming the path it refused.
      expect(turnsOf(instruction)[1]!.lastToolResult).toMatch(
        new RegExp(`^upload ${JSON.stringify(path).replaceAll('.', '\\.')} to #\\S+ failed: POLICY_DENIED: ${JSON.stringify(path).replaceAll('.', '\\.')} is`),
      );
    }
  });

  it('scrolls a listed node into view as one action', () => {
    expect(resultByTitle(outcome, 'scrolls a listed node into view').status).toBe('passed');
    const actions = engineEvents('scrolls a listed node into view');
    expect(actions.map((event) => event.name)).toEqual(['scrollIntoView']);
    expect(actions[0]!.detail).toMatch(/^scroll \S+ "Footnote" into view$/);
    expect(turnsOf('scroll to the footnote')[1]!.lastToolResult).toMatch(/^Scrolled into view #\S+\./);
  });

  it('pages a windowed list to a row by its text as one action, and brings it into view', () => {
    expect(resultByTitle(outcome, 'pages a windowed list to a row it has not rendered').status).toBe('passed');
    const step = stepOf('pages a windowed list to a row it has not rendered');
    const actions = step.events.filter((event) => event.kind === 'engine');
    expect(actions.map((event) => event.name)).toEqual(['scrollUntil']);
    expect(actions[0]!.detail).toMatch(/^scroll down on list "Ledger" until "Row 333" shows \(\d+ screens\)$/);
    // Forty-odd pages of the list, one action of the budget.
    expect(step.metrics!.actionSteps).toBe(1);
    expect(turnsOf('scroll the ledger')[1]!.lastToolResult).toMatch(/^Scrolled down until "Row 333" was in view\./);
    expect(turnsOf('scroll the ledger')[1]!.lastToolResult).toMatch(/Row 333 · Golden/);
  });

  it('repeats a key in one call, one engine action per press, and shows the selection it made', () => {
    const title = 'selects one word with a repeated press and sees the selection';
    expect(resultByTitle(outcome, title).status).toBe('passed');
    const actions = engineEvents(title);
    // The first press addresses the node; the seven after it ride the focus it took.
    expect(actions.map((event) => event.name)).toEqual(['tap', 'press', ...Array.from({ length: 7 }, () => 'pressKey')]);
    expect(actions[1]!.detail).toBe('press "Shift+ArrowLeft" on textbox "Memo"');
    expect(stepOf(title).metrics!.actionSteps).toBe(9);
    const [, , third] = turnsOf('select the last word of the memo');
    expect(third!.lastToolResult).toMatch(/^Pressed Shift\+ArrowLeft 8 times on #\S+\./);
    expect(third!.lastToolResult).toMatch(/changed #\S+ textbox "Memo" value="release approved" selection="approved"/);
  });

  it('walks focus on with a repeated Tab instead of returning to the node each time', () => {
    const title = 'tabs from the terms checkbox to the memo with one repeated press';
    expect(resultByTitle(outcome, title).status).toBe('passed');
    const actions = engineEvents(title);
    expect(actions.map((event) => event.name)).toEqual(['press', 'pressKey']);
    expect(actions[0]!.detail).toBe('press "Tab" on checkbox "Agree to terms"');
    const [, second] = turnsOf('tab from the terms checkbox');
    expect(second!.lastToolResult).toMatch(/^Pressed Tab 2 times on #\S+\./);
    expect(second!.lastToolResult).toMatch(/changed #\S+ textbox "Memo" value="release approved" selection="release approved"/);
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
  const flows = FLOWS.filter((flow) => flow.replays === true);
  let app: FixtureApp;
  let project: FixtureProject;
  let firstRun: RunOutcome;
  let secondRun: RunOutcome;
  let secondRunModelCalls = 0;

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ 'tests/replay.e2e.ts': suiteOf(flows), ...PROJECT_FILES });
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

  it('records every verb on the first run', () => {
    expect(firstRun.exitCode).toBe(0);
    for (const flow of flows) {
      expect(actStepOf(firstRun, flow.title).cache, flow.title).toMatchObject({ mode: 'missed', reason: 'no-entry' });
    }
  });

  it('replays hover, drag, check, upload, and scroll into view without a model call, and runs a round trip that changed nothing live', () => {
    expect(secondRun.exitCode).toBe(0);
    // A round trip leaves the screen and the route as it found them: nothing a
    // replay could check, so it is never recorded and the model runs it again.
    const roundTrip = actStepOf(secondRun, 'opens a page and comes back');
    expect(roundTrip.cache).toMatchObject({ mode: 'missed', reason: 'no-entry' });
    expect(secondRunModelCalls).toBe(roundTrip.metrics!.modelCalls);
    for (const flow of flows.filter((entry) => entry.title !== 'opens a page and comes back')) {
      const step = actStepOf(secondRun, flow.title);
      expect(step.cache, flow.title).toMatchObject({ mode: 'self-finalized' });
      expect(step.metrics!.modelCalls, flow.title).toBe(0);
    }
    const engineNames = (title: string) => actStepOf(secondRun, title).events.filter((event) => event.kind === 'engine').map((event) => event.name);
    expect(engineNames('hovers the menu trigger and taps what it reveals')).toEqual(['hover', 'tap']);
    expect(engineNames('drags the card onto the done column')).toEqual(['dragTo']);
    expect(actStepOf(secondRun, 'uploads a project file').events.filter((event) => event.kind === 'policy')).toEqual([
      expect.objectContaining({ name: 'upload.path', decision: 'allowed' }),
    ]);
  });
});

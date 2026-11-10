/** A caret key in a focused text field waits a second for its effect; a tap, a first focus, or a batched earlier action still waits the full window. */

import { describe, expect, it } from 'vitest';
import type { StepExecutorContext, StepExecutor } from '../../src/agent/executor.ts';
import { createFakeEngine, FAKE_APP, FAKE_APP_URL } from '../helpers/fake-engine.ts';
import { nodeIdFor } from '../helpers/fake-loop-model.ts';
import { createProject, runExisting } from '../helpers/run-project.ts';
import type { ScriptedNode } from '../helpers/scripted-scene.ts';

const SUITE = `import { test } from 'e2e';
test('acts on the field', async ({ app, agent }) => {
  await app.open();
  await agent.act('act on the field');
});`;

/** How long after the action the field's popup opens, and whether the field already held the focus. */
interface Case {
  readonly field: 'focused' | 'unfocused';
  readonly opensAfterMs: number | undefined;
}

interface Ids {
  readonly field: string;
  readonly button: string;
}

type Act = (context: StepExecutorContext, ids: Ids) => Promise<void>;

/** Runs one action on a text field in a scene whose popup opens `opensAfterMs` after it, and reports the look after it. */
async function lookAfter(scenario: Case, act: Act): Promise<{ readonly text: string; readonly ms: number }> {
  let seen = { text: '', ms: 0 };
  const fake = createFakeEngine({
    actions: ['tap', 'press'],
    keyboard: true,
    scene: (stage) => {
      const popup: ScriptedNode = { id: 'popup', role: 'status', name: 'Suggestions', text: 'closed' };
      const open = (): void => {
        if (scenario.opensAfterMs !== undefined) stage.after(scenario.opensAfterMs, () => { popup.text = 'open'; });
      };
      return [popup, {
        id: 'button', role: 'button', name: 'Go',
        rect: { x: 0, y: 80, width: 100, height: 40 },
        on: (action) => { if (action.kind === 'tap') open(); },
      }, {
        id: 'field', role: 'textbox', name: 'Search', value: 'release approved',
        rect: { x: 0, y: 20, width: 100, height: 40 },
        ...(scenario.field === 'focused' ? { states: { focused: true } } : {}),
        on: (action) => { if (action.kind === 'tap' || action.kind === 'press') open(); },
      }];
    },
  });
  const executor: StepExecutor = {
    name: 'caret-settle', version: '1',
    async runStep(context) {
      const first = await context.observe();
      await act(context, { field: nodeIdFor(first.text, /textbox "Search"/u), button: nodeIdFor(first.text, /button "Go"/u) });
      const started = Date.now();
      const after = await context.observe();
      seen = { text: after.text, ms: Date.now() - started };
      return { status: 'passed', summary: 'acted on the field' };
    },
  };
  const project = createProject({ 'tests/caret.e2e.ts': SUITE });
  try {
    const outcome = await runExisting(project, {
      appUrl: FAKE_APP_URL,
      config: { tests: 'tests/**/*.e2e.ts', targets: [{ name: 'surface', platform: 'web', engine: fake.engine, app: FAKE_APP }], agents: { default: { executor } } },
    });
    expect(outcome.exitCode, JSON.stringify(outcome.report.run.errors)).toBe(0);
    return seen;
  } finally {
    project.cleanup();
  }
}

const tapField: Act = (context, { field }) => context.actions.tap({ id: field });
const pressField: Act = (context, { field }) => context.actions.press({ id: field }, 'ArrowRight');
const pressKey: Act = (context) => context.actions.pressKey('ArrowRight');
const batched: Act = async (context, { button }) => {
  await context.actions.tap({ id: button });
  await context.actions.pressKey('End');
};

describe('the look after a caret key in a text field', () => {
  it.each([
    ['a first tap on the field', 'unfocused', tapField],
    ['a tap on the focused field', 'focused', tapField],
    ['a caret key pressed on the field before it held the focus', 'unfocused', pressField],
    ['a tap on a button followed by a caret key in the same turn', 'focused', batched],
  ] as const)('still waits for what %s opens', async (_name, field, act) => {
    const look = await lookAfter({ field, opensAfterMs: 700 }, act);
    expect(look.text).toContain('open');
  });

  it.each([
    ['a caret key pressed on the focused field', pressField],
    ['a caret key sent to the focused field', pressKey],
  ] as const)('still reads what a handler opens 700 ms after %s', async (_name, act) => {
    const look = await lookAfter({ field: 'focused', opensAfterMs: 700 }, act);
    expect(look.text).toContain('open');
  });

  it.each([
    ['a caret key pressed on the focused field', pressField],
    ['a caret key sent to the focused field', pressKey],
  ] as const)('does not wait out the whole change window for %s that changes nothing', async (_name, act) => {
    const look = await lookAfter({ field: 'focused', opensAfterMs: undefined }, act);
    expect(look.ms).toBeLessThan(1600);
  });
});

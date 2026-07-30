/**
 * Locating nodes no query can name (spec 02-test-api.md, 10-determinism.md).
 *
 * A form whose labels are sibling table cells gives every control a role and
 * nothing else: no accessible name, no test id, no placeholder, no text. That is
 * the case the agent tier exists for — it is also the case the locate sweep
 * refused outright, because `deriveQueries` returned an empty list and the guard
 * for it threw before the reference and selector paths could run. The tier
 * therefore failed hardest on exactly the pages that cannot be addressed
 * deterministically either.
 *
 * The other two pages here are documents the observation walk used to stop at:
 * an open shadow root, and a frame the page writes itself with no network origin
 * for an allowlist to match.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import {
  fakeCalls,
  installFakeModel,
  locateNth,
  type FakeCall,
} from '../helpers/fake-model.ts';
import { resultByTitle, runProject, type FixtureProject } from '../helpers/run-project.ts';
import type { RunOutcome } from '../helpers/run-project.ts';

const SUITE = `import { test, expect } from 'e2e';

test('types into a control whose label is a table cell', async ({ agent, web }) => {
  await web.goto('/unnamed');
  await agent.type('the nickname field', 'Ada');
  await expect(web.locator('#nickname')).toHaveValue('Ada');
});

test('selects in an unnamed dropdown', async ({ agent, web }) => {
  await web.goto('/unnamed');
  await agent.select('the plan choice dropdown', 'Pro tier');
  await expect(web.locator('#tier')).toHaveValue('pro');
});

test('unchecks an unnamed pre-checked box', async ({ agent, web }) => {
  await web.goto('/unnamed');
  await agent.uncheck('the pre-checked box');
  await expect(web.locator('#flag')).not.toBeChecked();
});

test('taps a node reachable only through its reference', async ({ agent, screen, web }) => {
  await web.goto('/unnamed');
  await agent.tap('the badge image');
  await expect(screen.getByRole('status', { name: 'State' })).toHaveText('badge tapped');
});

test('taps an empty painted rectangle', async ({ agent, screen, web }) => {
  await web.goto('/unnamed');
  await agent.tap('the empty bordered rectangle');
  await expect(screen.getByRole('status', { name: 'State' })).toHaveText('zone tapped');
});

test('drags onto an empty drop zone', async ({ agent, screen, web }) => {
  await web.goto('/unnamed');
  await agent.dragTo('the ticket image', 'the empty bordered rectangle');
  await expect(screen.getByRole('status', { name: 'Drops' })).toHaveText('dropped');
});

test('dragging with both endpoints reference-only still fails', async ({ agent, web }) => {
  await web.goto('/unnamed');
  let code = '';
  try {
    await agent.dragTo('the badge image', 'the empty bordered rectangle');
  } catch (error) {
    code = error instanceof Error ? String(Reflect.get(error, 'code')) : '';
  }
  expect(code).toBe('LOCATOR_NOT_FOUND');
});

test('acts on a control inside an open shadow root', async ({ agent, screen, web }) => {
  await web.goto('/shadow');
  await agent.tap('the shadow action button');
  await expect(screen.getByRole('status', { name: 'Picked' })).toHaveText('shadow');
});

test('acts inside a frame the page wrote itself', async ({ agent, web }) => {
  await web.goto('/data-frame');
  await agent.check('the Confirm checkbox');
  await expect(web.frameLocator('#inline').getByLabel('Confirm')).toBeChecked();
});
`;

/**
 * Selections are scripted rather than matched by line similarity: most of these
 * nodes carry no text for a similarity match to work on — that is the point of
 * the page — and what is under test is how the runner resolves a selection, not
 * how a model arrives at one.
 */
const SELECTIONS: readonly (readonly [string, RegExp])[] = [
  ['the nickname field', /textbox/],
  ['the plan choice dropdown', /combobox/],
  ['the pre-checked box', /checkbox \[checked\]/],
  ['the badge image', /image$/],
  ['the ticket image', /testid="ticket"/],
  // Anchored on the role token: a bare /box/ matches "checkbox" first.
  ['the empty bordered rectangle', /#\S+ box(\s|$)/],
  ['the shadow action button', /button "Shadow action"/],
  ['the Confirm checkbox', /checkbox "Confirm"/],
];

function respond(call: FakeCall): unknown {
  const selection = SELECTIONS.find(([instruction]) => instruction === call.instruction);
  if (selection === undefined) throw new Error(`unscripted instruction: ${call.instruction}`);
  return locateNth(call, selection[1], 0);
}

describe('locating unnamed nodes', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    const model = installFakeModel(respond);
    const run = await runProject(
      { 'tests/unnamed.e2e.ts': SUITE },
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

  const policyNames = (title: string, api: string) =>
    stepOf(title, api)
      .events.filter((event) => event.kind === 'policy')
      .map((event) => event.name);

  it('types into a control no derived query can name', () => {
    const title = 'types into a control whose label is a table cell';
    expect(resultByTitle(outcome, title).status).toBe('passed');
  });

  it('selects and unchecks unnamed controls', () => {
    expect(resultByTitle(outcome, 'selects in an unnamed dropdown').status).toBe('passed');
    expect(resultByTitle(outcome, 'unchecks an unnamed pre-checked box').status).toBe('passed');
  });

  it('addresses an unnamed node by the platform selector, not only by reference', () => {
    // The distinguishing assertion. A reference alone would pass the tests above
    // and fail `dragTo`, which cannot dispatch through an element handle, so the
    // selector path is what makes an unnamed node a first-class located node.
    expect(policyNames('types into a control whose label is a table cell', 'agent.type')).toContain(
      'locate.selector',
    );
  });

  it('falls back to the reference when nothing anchors a selector', () => {
    // The second rung. An `<img>` with no test id and no form `name` has no
    // anchored selector by design — an id-rooted path would be single-use on any
    // framework that mints ids per render — so the reference carries the action.
    const title = 'taps a node reachable only through its reference';
    expect(resultByTitle(outcome, title).status).toBe('passed');
    expect(policyNames(title, 'agent.tap')).toContain('locate.reference');
  });

  it('observes an empty painted rectangle that no query can describe', () => {
    // The element class defined by being empty. Without it a drop zone is not in
    // the tree at all, so no instruction can name one and `dragTo` has no
    // destination.
    const title = 'taps an empty painted rectangle';
    expect(resultByTitle(outcome, title).status).toBe('passed');
  });

  it('drags onto an empty drop zone', () => {
    expect(resultByTitle(outcome, 'drags onto an empty drop zone').status).toBe('passed');
  });

  it('leaves an unpainted box of the same size out of the tree', () => {
    // The guard on the rule above. `#spacer` is `#zone` without a border: a
    // person cannot see it or aim at it, and a rule that admitted it would put
    // every layout div in front of the model. The page holds exactly one painted
    // empty box, so no observation of it may ever report two.
    const perCall = fakeCalls.map(
      (call) => call.lines.filter((line) => /#\S+ box(\s|$)/.test(line)).length,
    );
    expect(Math.max(...perCall)).toBe(1);
    expect(perCall.some((count) => count === 1)).toBe(true);
  });

  it('pins the drag case the observation lifecycle still blocks', () => {
    // A reference-only *destination* now works: the pointer drag accepts an
    // element handle, and the destination is resolved last so its generation is
    // the live one. A reference-only *source* does not, and not because of the
    // drag: `dragTo` takes four observations (a cache probe and a model input per
    // locate) and each one disposes the generation before it, so the source
    // handle is gone by the time the drag dispatches. Retaining generations is a
    // driver lifecycle decision, not part of this change.
    const title = 'dragging with both endpoints reference-only still fails';
    expect(resultByTitle(outcome, title).status).toBe('passed');
  });

  it('sees into an open shadow root', () => {
    const title = 'acts on a control inside an open shadow root';
    expect(resultByTitle(outcome, title).status).toBe('passed');
  });

  it('sees into a frame with no network origin', () => {
    const title = 'acts inside a frame the page wrote itself';
    expect(resultByTitle(outcome, title).status).toBe('passed');
  });

  it('spends one model call per located action', () => {
    // Resolution is runner-side: the new paths cost driver reads, never calls.
    for (const [title, api] of [
      ['types into a control whose label is a table cell', 'agent.type'],
      ['acts on a control inside an open shadow root', 'agent.tap'],
    ] as const) {
      expect(stepOf(title, api).metrics?.modelCalls).toBe(1);
    }
  });
});

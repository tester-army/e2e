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
 * The other page here is a document the observation walk used to stop at: an open
 * shadow root. Its `data:` neighbour is the counter-example — denied by name in
 * 14-security.md, so it stays outside the agent's view on purpose.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import {
  fakeCalls,
  installFakeModel,
  locateNotFound,
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

test('types into an unnamed control inside a frame, not its twin outside', async ({
  agent,
  screen,
  web,
}) => {
  await web.goto('/frame-twin');
  await agent.type('the pin field inside the frame', '1234');

  const inner = web.frameLocator('#inner');
  await expect(inner.getByRole('status', { name: 'Inside' })).toHaveText('inner typed');
  await expect(screen.getByRole('status', { name: 'Outer' })).toHaveText('untouched');
  await expect(inner.getByRole('textbox')).toHaveValue('1234');
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

test('drags onto a zone that starts below the fold', async ({ agent, screen, web }) => {
  await web.goto('/drag-scroll');
  await agent.dragTo('the chip image', 'the near bordered rectangle');
  await expect(screen.getByRole('status', { name: 'Drops' })).toHaveText('dropped on near');
});

test('refuses a drag whose endpoints cannot share a viewport', async ({ agent, screen, web }) => {
  await web.goto('/drag-scroll');
  let message = '';
  try {
    await agent.dragTo('the chip image', 'the far bordered rectangle');
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  // The point is that it says so rather than reporting a drag that ran and did
  // nothing: a silent no-op surfaces later as a confusing assertion.
  expect(message).toContain('viewport');
  await expect(screen.getByRole('status', { name: 'Drops' })).toHaveText('none');
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

test('cannot see into a frame the page wrote itself', async ({ agent, web }) => {
  await web.goto('/data-frame');
  // 14-security.md denies the "data:" scheme by name, so an inline frame stays a
  // boundary node and the agent has no node inside it to select. The control is
  // still reachable deterministically.
  let code = '';
  try {
    await agent.check('the Confirm checkbox');
  } catch (error) {
    code = error instanceof Error ? String(Reflect.get(error, 'code')) : '';
  }
  expect(code).toBe('LOCATOR_NOT_FOUND');
  await web.frameLocator('#inline').getByLabel('Confirm').check();
  await expect(web.frameLocator('#inline').getByLabel('Confirm')).toBeChecked();
});
`;

/**
 * Selections are scripted rather than matched by line similarity: most of these
 * nodes carry no text for a similarity match to work on — that is the point of
 * the page — and what is under test is how the runner resolves a selection, not
 * how a model arrives at one.
 */
const SELECTIONS: readonly (readonly [string, RegExp, number?])[] = [
  ['the nickname field', /textbox/],
  ['the plan choice dropdown', /combobox/],
  ['the pre-checked box', /checkbox \[checked\]/],
  ['the badge image', /image$/],
  ['the ticket image', /testid="ticket"/],
  // Anchored on the role token: a bare /box/ matches "checkbox" first.
  ['the empty bordered rectangle', /#\S+ box(\s|$)/],
  ['the shadow action button', /button "Shadow action"/],
  // Deliberately the *second* textbox in the observation: the first is the decoy
  // in the outer document, the second is the one inside the frame.
  ['the pin field inside the frame', /textbox/, 1],
  ['the chip image', /testid="chip"/],
  // Two painted boxes on the page; the observation lists them in document order.
  ['the near bordered rectangle', /#\S+ box(\s|$)/, 0],
  ['the far bordered rectangle', /#\S+ box(\s|$)/, 1],
  ['the Confirm checkbox', /checkbox "Confirm"/],
];

function respond(call: FakeCall): unknown {
  const selection = SELECTIONS.find(([instruction]) => instruction === call.instruction);
  if (selection === undefined) throw new Error(`unscripted instruction: ${call.instruction}`);
  // Declining when the node is absent is what a model does; throwing would
  // surface as MODEL_PROVIDER_FAILED and hide the locate outcome under test.
  if (!call.lines.some((line) => selection[1].test(line))) {
    return locateNotFound(`no line matches ${String(selection[1])}`);
  }
  return locateNth(call, selection[1], selection[2] ?? 0);
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

  it('scopes a platform selector to the frame the node lives in', () => {
    // Without the frame chain the derived selector resolves in the outer
    // document, where a same-role element with no name passes the identity check
    // — so the run types into the wrong control and caches a selector that keeps
    // doing so. The frame chain only ever arrives with the observation: a
    // single-node read describes one element and not which document it came from.
    const title = 'types into an unnamed control inside a frame, not its twin outside';
    expect(resultByTitle(outcome, title).status).toBe('passed');
    expect(policyNames(title, 'agent.type')).toContain('locate.selector');
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

  it('scrolls a below-the-fold destination into view before aiming at it', () => {
    // `Locator.dragTo` scrolls both endpoints; a pointer sequence has to do the
    // same or it aims at a coordinate no element occupies.
    const title = 'drags onto a zone that starts below the fold';
    expect(resultByTitle(outcome, title).status).toBe('passed');
  });

  it('reports endpoints that cannot be reached in one gesture', () => {
    const title = 'refuses a drag whose endpoints cannot share a viewport';
    expect(resultByTitle(outcome, title).status).toBe('passed');
  });

  it('leaves an unpainted box of the same size out of the tree', () => {
    // The guard on the rule above. `#spacer` is `#zone` without a border: a
    // person cannot see it or aim at it, and a rule that admitted it would put
    // every layout div in front of the model. The page holds exactly one painted
    // empty box, so no observation of it may ever report two.
    // Scoped to observations of the page that holds the pair: other fixture
    // pages carry a different number of painted boxes.
    const perCall = fakeCalls
      .filter((call) => call.lines.some((line) => line.includes('Pre-checked:')))
      .map((call) => call.lines.filter((line) => /#\S+ box(\s|$)/.test(line)).length);
    expect(perCall.length).toBeGreaterThan(0);
    expect(Math.max(...perCall)).toBe(1);
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

  it('keeps a data: frame out of observations, as the security spec requires', () => {
    // Pins the rule rather than the workaround: `data:` is denied by name in
    // 14-security.md, so admitting it is a spec change with its own review, not
    // something an observation walk decides.
    const title = 'cannot see into a frame the page wrote itself';
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

/**
 * Undeclared capabilities through the real runner against a scripted engine
 * that declares only `tap` and `focus`, the `tap` pointer kind, and no
 * keyboard: a declared action still works, a positioned tap skips the
 * `scrollIntoView` the engine lacks, and every undeclared kind fails with
 * UNSUPPORTED_CAPABILITY before reaching the engine.
 */

import { describe, expect, it } from 'vitest';
import { assertValidReport } from '../helpers/report-schema.ts';
import { failed, passed, scriptedSuite } from '../helpers/scripted-suite.ts';

const LIMITED = `import { test } from 'e2e';

test('a declared action still works', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByRole('button', { name: 'Submit' }).tap();
});

test('a positioned tap skips scrollIntoView when the engine lacks it', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByRole('image', { name: 'Map' }).tap({ position: { x: 1, y: 2 } });
});

test('an undeclared node action is UNSUPPORTED_CAPABILITY', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByRole('button', { name: 'Submit' }).hover();
});

test('an undeclared pointer action is UNSUPPORTED_CAPABILITY', async ({ app, screen }) => {
  await app.open('/');
  await screen.swipe({ from: { x: 1, y: 2 }, to: { x: 3, y: 4 } });
});

test('a direction swipe needs the swipe action', async ({ app, screen }) => {
  await app.open('/');
  await screen.swipe({ direction: 'down' });
});

test('pressSequentially needs a keyboard', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByLabel('City').pressSequentially('Wa');
});
`;

describe('scripted engine: undeclared capabilities', () => {
  const run = scriptedSuite('limited.e2e.ts', LIMITED, { actions: ['tap', 'focus'], pointerActions: ['tap'], keyboard: false });

  it('honors what the engine declares', () => {
    assertValidReport(run.outcome.report);
    const tapped = passed(run.outcome, 'a declared action still works');
    expect(run.fake.callsOf(tapped.id, 'perform').map((entry) => entry.action.kind)).toEqual(['tap']);
    const positioned = passed(run.outcome, 'a positioned tap skips scrollIntoView when the engine lacks it');
    expect(run.fake.callsOf(positioned.id, 'perform')).toEqual([]);
    expect(run.fake.callsOf(positioned.id, 'performAt').map((entry) => entry.point)).toEqual([{ x: 101, y: 302 }]);
  });

  it('fails an undeclared kind with UNSUPPORTED_CAPABILITY before reaching the engine', () => {
    const cases: [string, string][] = [
      ['an undeclared node action is UNSUPPORTED_CAPABILITY', 'the "hover" action is not available on this target: its engine declares tap, focus'],
      ['an undeclared pointer action is UNSUPPORTED_CAPABILITY', 'the "swipeTo" action at a point is not available on this target: its engine declares tap'],
      ['a direction swipe needs the swipe action', 'target "fake" has no engine capability for swipe gestures: engine fake does not implement it'],
      ['pressSequentially needs a keyboard', 'pressSequentially is not available on this target: its engine declares no keyboard'],
    ];
    for (const [title, message] of cases) {
      const attempt = failed(run.outcome, title, 'UNSUPPORTED_CAPABILITY', message);
      expect(attempt.error?.category, title).toBe('configuration');
      expect(run.fake.callsOf(attempt.id, 'perform'), title).toEqual([]);
      expect(run.fake.callsOf(attempt.id, 'performAt'), title).toEqual([]);
    }
  });
});

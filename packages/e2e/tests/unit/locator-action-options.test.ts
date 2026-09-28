/**
 * Every locator action refuses an option key it does not take. A JavaScript
 * test ported from Playwright can pass `{ trial: true }` or `{ force: true }`;
 * ignoring the key would commit the action the test meant to only rehearse,
 * so the call fails before a node is resolved or a step recorded.
 */

import { describe, expect, it, vi } from 'vitest';
import { resolveExpression, type LocatorExpression } from '../../src/engine/index.ts';
import type { ActionOptions, Locator, Screen } from '../../src/types.ts';
import { invalid } from '../helpers/invalid.ts';
import { screenOver } from '../helpers/screen-over.ts';
import { snapshot } from '../helpers/snapshot.ts';

const BOX = { ref: { id: 'agree', revision: '' }, role: 'checkbox' as const, name: 'Agree' };
const BIN = { ref: { id: 'bin', revision: '' }, role: 'region' as const, name: 'Bin' };
const NODES = [BOX, BIN];

type Call = (locator: Locator, options: ActionOptions, screen: Screen) => Promise<void>;

const CALLS: Record<string, Call> = {
  tap: (locator, options) => locator.tap(options),
  click: (locator, options) => locator.click(options),
  doubleTap: (locator, options) => locator.doubleTap(options),
  secondaryTap: (locator, options) => locator.secondaryTap(options),
  longPress: (locator, options) => locator.longPress(options),
  fill: (locator, options) => locator.fill('yes', options),
  clear: (locator, options) => locator.clear(options),
  press: (locator, options) => locator.press('Enter', options),
  check: (locator, options) => locator.check(options),
  uncheck: (locator, options) => locator.uncheck(options),
  selectOption: (locator, options) => locator.selectOption('Team', options),
  focus: (locator, options) => locator.focus(options),
  hover: (locator, options) => locator.hover(options),
  setInputFiles: (locator, options) => locator.setInputFiles('fixtures/a.txt', options),
  dragTo: (locator, options, screen) => locator.dragTo(screen.getByRole('region', { name: 'Bin' }), options),
  scrollIntoView: (locator, options) => locator.scrollIntoView(options),
  swipe: (locator, options) => locator.swipe({ direction: 'down', ...options }),
};

/** A screen over a checkbox and a drop region, logging every node lookup and every action the engine receives. */
function boxScreen() {
  const performed: string[] = [];
  const locate = vi.fn(async (expression: LocatorExpression) => resolveExpression(expression, NODES));
  const { screen, steps } = screenOver({
    locate,
    observe: () => snapshot(NODES),
    perform: (_ref, action) => {
      performed.push(action.kind);
    },
    timeoutMs: 1_000,
  });
  return { screen, steps, performed, locate };
}

describe('locator action options', () => {
  it.each(Object.entries(CALLS))('%s rejects an unknown option before any lookup, action, or step', async (verb, call) => {
    const { screen, steps, performed, locate } = boxScreen();
    await expect(
      Promise.resolve().then(() => call(screen.getByLabel('Agree'), invalid<ActionOptions>({ trial: true }), screen)),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringMatching(`^${verb} options has no key "trial"`) });
    expect(locate).not.toHaveBeenCalled();
    expect(performed).toEqual([]);
    expect(steps.all()).toEqual([]);
  });

  it.each(Object.entries(CALLS))('%s performs with a timeout', async (verb, call) => {
    const { screen, steps, performed } = boxScreen();
    await call(screen.getByLabel('Agree'), { timeout: 1_000 }, screen);
    expect(performed).toHaveLength(1);
    expect(steps.all()).toEqual([expect.objectContaining({ api: `locator.${verb}`, status: 'passed' })]);
  });
});

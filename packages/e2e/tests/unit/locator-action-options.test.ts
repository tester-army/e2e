/**
 * Every locator action refuses an option key it does not take. A JavaScript
 * test ported from Playwright can pass `{ trial: true }` or `{ force: true }`;
 * ignoring the key would commit the action the test meant to only rehearse,
 * so the call fails before a node is resolved or a step recorded.
 */

import { describe, expect, it, vi } from 'vitest';
import { resolveExpression, type KeyModifier, type LocatorAction, type LocatorExpression } from '../../src/engine/index.ts';
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

  describe('modifiers', () => {
    /** A screen over the box whose engine declares `tapModifiers` or not, keeping every action it receives. */
    function modifierScreen(tapModifiers: boolean | undefined) {
      const received: LocatorAction[] = [];
      const { screen, steps } = screenOver({
        locate: (expression) => resolveExpression(expression, NODES),
        observe: () => snapshot(NODES),
        perform: (_ref, action) => {
          received.push(action);
        },
        ...(tapModifiers === undefined ? {} : { tapModifiers }),
        timeoutMs: 1_000,
      });
      return { screen, steps, received };
    }

    it.each([
      ['tap', (locator: Locator) => locator.tap({ modifiers: ['Shift'] })],
      ['click', (locator: Locator) => locator.click({ modifiers: ['Shift'] })],
      ['doubleTap', (locator: Locator) => locator.doubleTap({ modifiers: ['Shift'] })],
      ['secondaryTap', (locator: Locator) => locator.secondaryTap({ modifiers: ['Shift'] })],
    ] as const)('%s hands the held keys to an engine that declares tapModifiers', async (verb, call) => {
      const { screen, steps, received } = modifierScreen(true);
      await call(screen.getByLabel('Agree'));
      expect(received).toEqual([{ kind: verb === 'click' ? 'tap' : verb, modifiers: ['Shift'] }]);
      expect(steps.all()).toEqual([
        expect.objectContaining({ api: `locator.${verb}`, label: 'getByLabel("Agree") with Shift', status: 'passed' }),
      ]);
    });

    it('leaves the field off an action that names no modifier, an empty list included', async () => {
      const { screen, received } = modifierScreen(undefined);
      await screen.getByLabel('Agree').tap({ modifiers: [] });
      await screen.getByLabel('Agree').doubleTap();
      expect(received).toEqual([{ kind: 'tap' }, { kind: 'doubleTap' }]);
    });

    it('refuses modifiers on an engine that does not declare tapModifiers, before it acts', async () => {
      const { screen, received } = modifierScreen(undefined);
      await expect(screen.getByLabel('Agree').tap({ modifiers: ['Shift'] })).rejects.toMatchObject({
        code: 'UNSUPPORTED_CAPABILITY',
        message: expect.stringContaining('modifiers on the "tap" action'),
      });
      expect(received).toEqual([]);
    });

    it('refuses modifiers on such an engine before resolving, so a missing node is not LOCATOR_NOT_FOUND', async () => {
      const { screen } = modifierScreen(undefined);
      const started = Date.now();
      await expect(screen.getByLabel('Missing').secondaryTap({ modifiers: ['Alt'] })).rejects.toMatchObject({
        code: 'UNSUPPORTED_CAPABILITY',
      });
      expect(Date.now() - started).toBeLessThan(500);
    });

    it.each([
      [invalid<readonly KeyModifier[]>(['Hyper']), /modifier "Hyper" is not one of Shift, Control, Alt, Meta, ControlOrMeta/],
      [invalid<readonly KeyModifier[]>('Shift'), /modifiers must be an array/],
      [['Shift', 'Shift'] as const, /names a modifier twice/],
    ])('rejects modifiers %j before any lookup', async (modifiers, message) => {
      const { screen, received } = modifierScreen(true);
      await expect(
        Promise.resolve().then(() => screen.getByLabel('Agree').tap({ modifiers })),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringMatching(message) });
      expect(received).toEqual([]);
    });

    it('quotes a modifier JSON cannot serialize without throwing its own error', async () => {
      const { screen } = modifierScreen(true);
      await expect(
        Promise.resolve().then(() => screen.getByLabel('Agree').tap({ modifiers: invalid<readonly KeyModifier[]>([1n]) })),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('modifier a bigint is not one of') });
    });

    it('refuses modifiers with a position, which the pointer path cannot hold yet', async () => {
      const { screen } = modifierScreen(true);
      await expect(
        Promise.resolve().then(() => screen.getByLabel('Agree').tap({ modifiers: ['Shift'], position: { x: 1, y: 1 } })),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('modifiers with a position') });
    });
  });
});

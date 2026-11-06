/**
 * Whether an operation sent input is read off its own sends: input another
 * operation sends meanwhile, or the page mutation of an evaluate, leaves it
 * undispatched, so its failure stays retryable instead of possibly committed.
 */

import { describe, expect, it } from 'vitest';
import { BidiInput, DispatchScope } from '../../src/bidi/bidi-input.ts';
import { BROWSER_TRAITS } from '../../src/browsers.ts';
import { FakeBidi } from '../helpers/bidi-fake.ts';

/** Input on one fake tab with a 100 by 100 viewport. */
function input(): BidiInput {
  const fake = new FakeBidi().on('input.performActions', { result: {} });
  return new BidiInput({ connection: fake.connection, traits: BROWSER_TRAITS.chromium, context: () => 'tab', viewport: async () => ({ width: 100, height: 100 }) });
}

describe('DispatchScope', () => {
  it('counts only the sends of the work it runs', async () => {
    const keyboard = input();
    const waiting = new DispatchScope();
    const typing = new DispatchScope();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const waited = waiting.run(async () => {
      await held;
    });
    await typing.run(() => keyboard.press('a'));
    keyboard.mutated();
    release();
    await waited;
    expect(typing.dispatched).toBe(true);
    expect(waiting.dispatched).toBe(false);
    expect(keyboard.dispatches).toBe(2);
  });

  it('counts a page mutation made inside its work', async () => {
    const keyboard = input();
    const filling = new DispatchScope();
    await filling.run(async () => keyboard.mutated());
    expect(filling.dispatched).toBe(true);
  });
});

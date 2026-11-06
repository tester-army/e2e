/** Chromium drags over the `goog:cdp` passthrough: whatever fails, interception ends and the mouse button comes up, and keys stay as the test holds them. */

import { describe, expect, it } from 'vitest';
import { BidiInput } from '../../src/bidi/bidi-input.ts';
import { BROWSER_TRAITS } from '../../src/browsers.ts';
import { chromiumDrag } from '../../src/bidi/drag.ts';
import { FakeBidi } from '../helpers/bidi-fake.ts';

const FROM = { x: 1, y: 1 };
const TO = { x: 9, y: 9 };

/** Drags from `FROM` to `TO` on `fake`'s tab through a fresh input. */
function drag(fake: FakeBidi, signal: AbortSignal): Promise<void> {
  const input = new BidiInput({ connection: fake.connection, traits: BROWSER_TRAITS.chromium, context: () => 'tab', viewport: async () => ({ width: 100, height: 100 }) });
  return chromiumDrag(input, fake.connection, 'tab', ['tab'], FROM, async () => TO, 0, signal);
}

/** A peer whose CDP passthrough answers every command but the ones `fail` names. */
function peer(fail: (method: string, params: Record<string, unknown>, attempt: number) => boolean): FakeBidi {
  const attempts = new Map<string, number>();
  return new FakeBidi()
    .on('goog:cdp.getSession', { result: { session: 's1' } })
    .on('session.subscribe', { result: { subscription: 'sub' } })
    .on('script.callFunction', { result: { type: 'success', realm: 'r', result: { type: 'boolean', value: false } } })
    .on('goog:cdp.sendCommand', (params) => {
      const key = `${String(params['method'])}:${JSON.stringify(params['params'])}`;
      const attempt = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, attempt);
      return fail(String(params['method']), params['params'] as Record<string, unknown>, attempt) ? { error: 'unknown error', message: 'boom' } : { result: {} };
    })
    .on('input.performActions', (params) => {
      const pointer = (params['actions'] as { actions: { type: string }[] }[])[0]!;
      return fail('performActions', { first: pointer.actions.at(-1)!.type }, 1) ? { error: 'unknown error', message: 'boom' } : { result: {} };
    });
}

/** The pointer actions sent, each call's last action type. */
function pointerEnds(fake: FakeBidi): string[] {
  return fake.commands('input.performActions').map((command) => (command.params['actions'] as { actions: { type: string }[] }[])[0]!.actions.at(-1)!.type);
}

describe('chromiumDrag', () => {
  it('turns interception off again when the first disable fails, and lifts the button', async () => {
    const fake = peer((method, params, attempt) => method === 'Input.setInterceptDrags' && params['enabled'] === false && attempt === 1);
    await expect(drag(fake, AbortSignal.timeout(500))).rejects.toThrow();
    const toggles = fake.commands('goog:cdp.sendCommand').filter((command) => command.params['method'] === 'Input.setInterceptDrags').map((command) => (command.params['params'] as { enabled: boolean }).enabled);
    expect(toggles).toEqual([true, false, false]);
    expect(pointerEnds(fake).at(-1)).toBe('pointerUp');
    expect(fake.commands('input.releaseActions')).toEqual([]);
  });

  it('lifts the button when the press itself failed', async () => {
    const fake = peer((method, params) => method === 'performActions' && params['first'] === 'pointerDown');
    await expect(drag(fake, AbortSignal.timeout(500))).rejects.toThrow();
    expect(pointerEnds(fake)).toEqual(['pointerDown', 'pointerUp']);
  });

  it('releases where the mouse was when the drag failed midway, never at the target', async () => {
    const fake = peer((method) => method === 'Input.setInterceptDrags');
    await expect(drag(fake, AbortSignal.timeout(500))).rejects.toThrow();
    const sent = fake.commands('input.performActions').map((command) => (command.params['actions'] as { actions: { type: string; x?: number }[] }[])[0]!.actions);
    expect(sent.at(-1)).toEqual([{ type: 'pointerUp', button: 0 }]);
    expect(sent.flat().some((action) => action.type === 'pointerMove' && action.x === 9)).toBe(false);
  });

  it('resolves the target only once the source is pressed', async () => {
    const fake = peer(() => false);
    const input = new BidiInput({ connection: fake.connection, traits: BROWSER_TRAITS.chromium, context: () => 'tab', viewport: async () => ({ width: 100, height: 100 }) });
    let sentBefore = -1;
    await chromiumDrag(input, fake.connection, 'tab', ['tab'], FROM, async () => {
      sentBefore = pointerEnds(fake).length;
      return TO;
    }, 0, AbortSignal.timeout(500));
    expect(sentBefore).toBe(1);
    expect(pointerEnds(fake)[0]).toBe('pointerDown');
    expect(input.pointer).toEqual(TO);
  });

  it('moves with the pressure a held button gives, as every other pointer input does', async () => {
    const fake = peer(() => false);
    await drag(fake, AbortSignal.timeout(500));
    const moves = fake.commands('input.performActions').flatMap((command) => (command.params['actions'] as { actions: { type: string; pressure?: number }[] }[])[0]!.actions).filter((action) => action.type === 'pointerMove');
    expect(moves.slice(1).map((action) => action.pressure)).toEqual([0.5, 0.5, 0.5, 0.5, 0.5]);
  });

  it('sends nothing when cancelled before the press', async () => {
    const fake = peer(() => false);
    await expect(drag(fake, AbortSignal.abort())).rejects.toThrow();
    expect(fake.commands('input.performActions')).toEqual([]);
  });
});

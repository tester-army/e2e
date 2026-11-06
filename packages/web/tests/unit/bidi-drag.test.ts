/** Chromium drags over the `goog:cdp` passthrough: whatever fails, interception ends and the mouse button comes up, and keys stay as the test holds them. */

import { describe, expect, it } from 'vitest';
import { chromiumDrag } from '../../src/bidi/drag.ts';
import { FakeBidi } from '../helpers/bidi-fake.ts';

const PATH = [{ x: 1, y: 1 }, { x: 5, y: 5 }, { x: 9, y: 9 }];

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
    await expect(chromiumDrag(fake.connection, 'tab', ['tab'], PATH, 0, AbortSignal.timeout(500))).rejects.toThrow();
    const toggles = fake.commands('goog:cdp.sendCommand').filter((command) => command.params['method'] === 'Input.setInterceptDrags').map((command) => (command.params['params'] as { enabled: boolean }).enabled);
    expect(toggles).toEqual([true, false, false]);
    expect(pointerEnds(fake).at(-1)).toBe('pointerUp');
    expect(fake.commands('input.releaseActions')).toEqual([]);
  });

  it('lifts the button when the press itself failed', async () => {
    const fake = peer((method, params) => method === 'performActions' && params['first'] === 'pointerDown');
    await expect(chromiumDrag(fake.connection, 'tab', ['tab'], PATH, 0, AbortSignal.timeout(500))).rejects.toThrow();
    expect(pointerEnds(fake)).toEqual(['pointerDown', 'pointerUp']);
  });

  it('releases where the mouse was when the drag failed midway, never at the target', async () => {
    const fake = peer((method) => method === 'Input.setInterceptDrags');
    await expect(chromiumDrag(fake.connection, 'tab', ['tab'], PATH, 0, AbortSignal.timeout(500))).rejects.toThrow();
    const sent = fake.commands('input.performActions').map((command) => (command.params['actions'] as { actions: { type: string; x?: number }[] }[])[0]!.actions);
    expect(sent.at(-1)).toEqual([{ type: 'pointerUp', button: 0 }]);
    expect(sent.flat().some((action) => action.type === 'pointerMove' && action.x === 9)).toBe(false);
  });

  it('sends nothing when cancelled before the press', async () => {
    const fake = peer(() => false);
    await expect(chromiumDrag(fake.connection, 'tab', ['tab'], PATH, 0, AbortSignal.abort())).rejects.toThrow();
    expect(fake.commands('input.performActions')).toEqual([]);
  });
});

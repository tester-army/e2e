/** A BiDi session's own state: held keys through chords and modifier clicks until their `keyboard.up`, and a user context that opens after the attempt closed. */

import { describe, expect, it } from 'vitest';
import { clickSources, fixtureKeySource, fixtureKeyStroke, strokeSource } from '../../src/bidi/input.ts';
import { BidiSession, ContextOwners } from '../../src/bidi/session.ts';
import { FakeBidi, settle } from '../helpers/bidi-fake.ts';

const SHIFT = '';

/** A session on `fake` with its tab open. */
function session(fake: FakeBidi): BidiSession {
  const settings = { siteHeaders: () => undefined, holdRequests: false, media: {}, viewport: null, browser: 'chromium', initScripts: { forAttempt: () => [] }, permissions: [] };
  const attempt = { credentials: undefined };
  const created = new BidiSession({ connection: fake.connection, exclusive: true } as never, settings as never, attempt as never, new ContextOwners());
  created.context = 'tab';
  return created;
}

describe('BidiSession.sendInput', () => {
  it('neither presses nor releases a modifier the test holds, and lets its own up release it', async () => {
    const fake = new FakeBidi().on('input.performActions', { result: {} });
    const held = session(fake);
    await held.sendInput([fixtureKeySource('Shift', 'keyDown', false)]);
    await held.sendInput([fixtureKeySource('Shift+ArrowRight', 'press', true)]);
    await held.sendInput(clickSources(5, 5, { modifiers: ['Shift'] }));
    await held.sendInput([fixtureKeySource('Shift', 'keyUp', true)]);
    const keys = fake.commands('input.performActions').map((command) =>
      (command.params['actions'] as { type: string; actions: { type: string; value?: string }[] }[]).filter((source) => source.type === 'key').flatMap((source) => source.actions));
    expect(keys[0]).toEqual([{ type: 'keyDown', value: SHIFT }]);
    expect(keys[1]!.some((action) => action.value === SHIFT)).toBe(false);
    expect(keys[2]!.some((action) => action.value === SHIFT)).toBe(false);
    expect(keys[3]).toEqual([{ type: 'keyUp', value: SHIFT }]);
  });

  it('keeps a click’s ticks when a held modifier joins one it adds', async () => {
    const fake = new FakeBidi().on('input.performActions', { result: {} });
    const held = session(fake);
    await held.sendInput([fixtureKeySource('Shift', 'keyDown', false)]);
    const click = clickSources(5, 5, { modifiers: ['Shift', 'Control'] });
    await held.sendInput(click);
    const sent = fake.commands('input.performActions').at(-1)!.params['actions'] as { type: string; actions: { type: string; value?: string }[] }[];
    const sentKeys = sent.find((source) => source.type === 'key')!.actions;
    const askedKeys = (click.find((source) => source.type === 'key') as { actions: unknown[] }).actions;
    expect(sentKeys).toHaveLength(askedKeys.length);
    expect(sentKeys.filter((action) => action.value === SHIFT)).toEqual([]);
    expect(sentKeys.filter((action) => action.value === '\uE009').map((action) => action.type)).toEqual(['keyDown', 'keyUp']);
  });

  it('sends a key WebDriver has no value for as CDP key events that carry the modifiers BiDi holds', async () => {
    const fake = new FakeBidi().on('input.performActions', { result: {} }).on('goog:cdp.getSession', { result: { session: 'cdp' } }).on('goog:cdp.sendCommand', { result: {} });
    const held = session(fake);
    const stroke = (key: string, phase: 'press' | 'keyDown' | 'keyUp') => {
      const parsed = fixtureKeyStroke(key, phase);
      return held.sendKey(parsed, (shiftHeld) => strokeSource(parsed, shiftHeld));
    };
    await stroke('Shift', 'keyDown');
    await stroke('MediaPlayPause', 'press');
    await stroke('Shift', 'keyUp');
    expect(fake.commands('input.performActions')).toHaveLength(2);
    const cdp = fake.commands('goog:cdp.sendCommand').map((command) => command.params as { method: string; session: string; params: { type: string; modifiers: number } });
    expect(cdp.map((command) => [command.session, command.params.type, command.params.modifiers])).toEqual([['cdp', 'rawKeyDown', 8], ['cdp', 'keyUp', 8]]);
  });

  it('forgets held keys with the tab that held them', async () => {
    const fake = new FakeBidi().on('input.performActions', { result: {} });
    const held = session(fake);
    await held.sendInput([fixtureKeySource('Shift', 'keyDown', false)]);
    held.retireContext();
    held.context = 'tab-2';
    expect(held.isHeld(SHIFT)).toBe(false);
    await held.sendInput([fixtureKeySource('Shift', 'keyDown', false)]);
    const last = fake.commands('input.performActions').at(-1)!.params['actions'] as { actions: { type: string; value?: string }[] }[];
    expect(last[0]!.actions).toEqual([{ type: 'keyDown', value: SHIFT }]);
  });
});

describe('BidiSession.close', () => {
  it('removes a user context that a reset opened after the attempt closed', async () => {
    let created: (reply: { result: unknown }) => void = () => undefined;
    const fake = new FakeBidi()
      .on('browser.createUserContext', () => new Promise((resolve) => (created = resolve)))
      .on('network.addDataCollector', { result: { collector: 'c' } });
    const closing = session(fake);
    const opening = closing.openUserContext();
    await settle();
    await closing.close();
    created({ result: { userContext: 'late' } });
    await expect(opening).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fake.commands('browser.removeUserContext').map((command) => command.params['userContext'])).toEqual(['late']);
    expect(fake.commands('script.addPreloadScript')).toEqual([]);
  });

  it('ends the attempt’s lifetime, so work it started that nothing awaits stops', async () => {
    const fake = new FakeBidi();
    const closing = session(fake);
    const lifetime = closing.lifetime;
    expect(lifetime.aborted).toBe(false);
    await closing.close();
    expect(lifetime.aborted).toBe(true);
  });

  it('owes a user context whose removal failed in a reset, and removes it on close', async () => {
    const fake = new FakeBidi().on('browser.createUserContext', { result: { userContext: 'first' } }).on('network.addDataCollector', { result: { collector: 'c' } });
    const closing = session(fake);
    await closing.openUserContext();
    fake.on('browser.removeUserContext', { error: 'unknown error', message: 'busy' });
    await expect(closing.dropUserContext()).rejects.toThrow('busy');
    fake.on('browser.removeUserContext', { result: {} });
    await closing.close();
    expect(fake.commands('browser.removeUserContext').map((command) => command.params['userContext'])).toEqual(['first', 'first']);
  });
});

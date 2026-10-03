/**
 * `locator.pressSequentially`: composed in core from the `focus` action and
 * the `keyboard` capability, with no engine contract growth. What the engine
 * sees, what the step records, and what is refused before any node resolves.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCATOR_ACTION_KINDS, type LocatorActionKind } from '../../src/engine/index.ts';
import { resolveConfig } from '../../src/config/resolve.ts';
import { secrets, setSecretRegistry } from '../../src/secrets.ts';
import { screenOver } from '../helpers/screen-over.ts';
import { snapshot } from '../helpers/snapshot.ts';

const FIELD = { ref: { id: 'city', revision: '' }, role: 'textbox' as const, name: 'City' };

/** A screen over an in-memory engine that logs every action and keystroke it receives. */
function fieldScreen(shape: { keyboard?: boolean; actions?: readonly LocatorActionKind[] } = {}) {
  const log: string[] = [];
  const locate = vi.fn(async () => [FIELD]);
  const { screen, steps } = screenOver({
    locate,
    observe: () => snapshot([FIELD]),
    ...(shape.actions === undefined ? {} : { actions: shape.actions }),
    perform: (ref, action) => {
      log.push(`${action.kind}:${ref.id}`);
    },
    ...(shape.keyboard === false
      ? {}
      : {
          keyboard: {
            type: async (text: string, options: { readonly replace: boolean }) => {
              log.push(`type:${text}${options.replace ? ':replace' : ''}`);
            },
            press: async (key: string) => {
              log.push(`press:${key}`);
            },
          },
        }),
    timeoutMs: 2_000,
  });
  return { screen, steps, log, locate };
}

afterEach(() => {
  vi.useRealTimers();
});

/** Puts the test on fake time that jumps to each next timer, so a typing delay costs no wall time. */
function autoAdvancingTime(): void {
  vi.useFakeTimers();
  vi.setTimerTickMode('nextTimerAsync');
}

describe('locator.pressSequentially', () => {
  it('focuses the one matching node, then types the whole text in one keyboard call', async () => {
    const { screen, steps, log } = fieldScreen();
    await screen.getByLabel('City').pressSequentially('Warsaw');
    expect(log).toEqual(['focus:city', 'type:Warsaw']);
    expect(steps.all()).toEqual([
      expect.objectContaining({ kind: 'locator', api: 'locator.pressSequentially', label: 'getByLabel("City")', status: 'passed' }),
    ]);
  });

  it('with a delay, types one character per call and waits between them', async () => {
    autoAdvancingTime();
    const { screen, log } = fieldScreen();
    const started = Date.now();
    await screen.getByLabel('City').pressSequentially('Wa', { delay: 60 });
    expect(log).toEqual(['focus:city', 'type:W', 'type:a']);
    expect(Date.now() - started).toBeGreaterThanOrEqual(60);
  });

  it('cuts a pause at the action deadline and sends no character past it', async () => {
    autoAdvancingTime();
    const { screen, log } = fieldScreen();
    const started = Date.now();
    await expect(screen.getByLabel('City').pressSequentially('ab', { delay: 1000, timeout: 100 })).rejects.toMatchObject({
      code: 'ACTION_FAILED',
      message: expect.stringContaining('typing 1 of 2 characters'),
    });
    // Returned before the 1000 ms pause could elapse; the log proves nothing went out past the cut.
    expect(Date.now() - started).toBeLessThan(1000);
    expect(log).toEqual(['focus:city', 'type:a']);
  });

  it('splits by code point, so a surrogate pair is one keystroke', async () => {
    const { screen, log } = fieldScreen();
    await screen.getByLabel('City').pressSequentially('a\u{1F600}', { delay: 0 });
    expect(log).toEqual(['focus:city', 'type:a', 'type:\u{1F600}']);
  });

  it('types nothing for an empty text but still focuses the field', async () => {
    const { screen, log } = fieldScreen();
    await screen.getByLabel('City').pressSequentially('');
    expect(log).toEqual(['focus:city']);
  });

  it('refuses a target whose engine has no keyboard before resolving any node', async () => {
    const { screen, locate, log } = fieldScreen({ keyboard: false });
    await expect(screen.getByLabel('City').pressSequentially('W')).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      message: expect.stringContaining('no keyboard'),
    });
    expect(locate).not.toHaveBeenCalled();
    expect(log).toEqual([]);
  });

  it('refuses a target whose engine does not declare the focus action', async () => {
    const { screen, locate } = fieldScreen({ actions: LOCATOR_ACTION_KINDS.filter((kind) => kind !== 'focus') });
    await expect(screen.getByLabel('City').pressSequentially('W')).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      message: expect.stringContaining('"focus" action'),
    });
    expect(locate).not.toHaveBeenCalled();
  });

  it('refuses a Secret with INVALID_ARGUMENT and points at fill, without touching the engine', async () => {
    const { screen, locate, log, steps } = fieldScreen();
    const config = resolveConfig(
      { targets: [{ name: 'fake', platform: 'custom' }], secrets: { key: 'sk_live_2718' } },
      { projectRoot: process.cwd(), env: {} },
    );
    setSecretRegistry(config);
    try {
      const handle = secrets.get('key');
      expect(() => screen.getByLabel('City').pressSequentially(handle as unknown as string)).toThrow(
        expect.objectContaining({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('fill') }),
      );
    } finally {
      setSecretRegistry(undefined);
    }
    expect(locate).not.toHaveBeenCalled();
    expect(log).toEqual([]);
    expect(JSON.stringify(steps.all())).not.toContain('sk_live_2718');
  });

  it('rejects a non-string text and a malformed delay as INVALID_ARGUMENT', () => {
    const { screen } = fieldScreen();
    const city = screen.getByLabel('City');
    expect(() => city.pressSequentially(42 as unknown as string)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(() => city.pressSequentially('W', { delay: -1 })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(() => city.pressSequentially('W', { delay: Number.NaN })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(() => city.pressSequentially('W', { delayMs: 5 } as never)).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('now "delay"') }),
    );
  });
});

/**
 * `locator.pressSequentially`: composed in core from the `focus` action and
 * the `keyboard` capability, with no engine contract growth. What the engine
 * sees, what the step records, and what is refused before any node resolves.
 */

import { describe, expect, it, vi } from 'vitest';
import { defineEngine, LOCATOR_ACTION_KINDS, type LocatorActionKind } from '../../src/engine/index.ts';
import { createEngineSession } from '../../src/engine/session.ts';
import { resolveConfig } from '../../src/config/resolve.ts';
import { secrets, setSecretRegistry } from '../../src/secrets.ts';
import { Deadline } from '../../src/internal/time.ts';
import { LocatorEngine } from '../../src/locator/engine.ts';
import { createScreen } from '../../src/locator/screen.ts';
import { AttemptBudget } from '../../src/run/budget.ts';
import { StepRecorder } from '../../src/run/steps.ts';
import { snapshot } from '../helpers/snapshot.ts';

const FIELD = { ref: { id: 'city', revision: '' }, role: 'textbox' as const, name: 'City' };

/** A screen over an in-memory engine that logs every action and keystroke it receives. */
function screenOver(shape: { keyboard?: boolean; actions?: readonly LocatorActionKind[] } = {}) {
  const log: string[] = [];
  const locate = vi.fn(async () => [FIELD]);
  const engine = defineEngine({
    name: 'fake',
    version: '1',
    spiVersion: 1,
    observe: async () => snapshot([FIELD]),
    locate,
    actions: shape.actions ?? LOCATOR_ACTION_KINDS,
    perform: async (ref, action) => {
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
  });
  const steps = new StepRecorder('attempt');
  const signal = new AbortController().signal;
  const locatorEngine = new LocatorEngine({
    session: createEngineSession({ engine, targetName: 'fake' }),
    budget: new AttemptBudget(signal, new Deadline(10_000)),
    runId: 'run',
    attemptId: 'attempt',
    actionTimeout: 2_000,
    assertionTimeout: 2_000,
  });
  const screen = createScreen({
    engine: locatorEngine,
    steps,
    secrets: { resolve: async () => 'plaintext' },
  });
  return { screen, steps, log, locate };
}

describe('locator.pressSequentially', () => {
  it('focuses the one matching node, then types the whole text in one keyboard call', async () => {
    const { screen, steps, log } = screenOver();
    await screen.getByLabel('City').pressSequentially('Warsaw');
    expect(log).toEqual(['focus:city', 'type:Warsaw']);
    expect(steps.all()).toEqual([
      expect.objectContaining({ kind: 'locator', api: 'locator.pressSequentially', label: 'getByLabel("City")', status: 'passed' }),
    ]);
  });

  it('with a delay, types one character per call and waits between them', async () => {
    const { screen, log } = screenOver();
    const started = Date.now();
    await screen.getByLabel('City').pressSequentially('Wa', { delay: 60 });
    expect(log).toEqual(['focus:city', 'type:W', 'type:a']);
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
  });

  it('cuts a pause at the action deadline and sends no character past it', async () => {
    const { screen, log } = screenOver();
    const started = Date.now();
    await expect(screen.getByLabel('City').pressSequentially('ab', { delay: 1000, timeout: 100 })).rejects.toMatchObject({
      code: 'ACTION_FAILED',
      message: expect.stringContaining('typing 1 of 2 characters'),
    });
    expect(Date.now() - started).toBeLessThan(600);
    expect(log).toEqual(['focus:city', 'type:a']);
  });

  it('splits by code point, so a surrogate pair is one keystroke', async () => {
    const { screen, log } = screenOver();
    await screen.getByLabel('City').pressSequentially('a\u{1F600}', { delay: 0 });
    expect(log).toEqual(['focus:city', 'type:a', 'type:\u{1F600}']);
  });

  it('types nothing for an empty text but still focuses the field', async () => {
    const { screen, log } = screenOver();
    await screen.getByLabel('City').pressSequentially('');
    expect(log).toEqual(['focus:city']);
  });

  it('refuses a target whose engine has no keyboard before resolving any node', async () => {
    const { screen, locate, log } = screenOver({ keyboard: false });
    await expect(screen.getByLabel('City').pressSequentially('W')).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      message: expect.stringContaining('no keyboard'),
    });
    expect(locate).not.toHaveBeenCalled();
    expect(log).toEqual([]);
  });

  it('refuses a target whose engine does not declare the focus action', async () => {
    const { screen, locate } = screenOver({ actions: LOCATOR_ACTION_KINDS.filter((kind) => kind !== 'focus') });
    await expect(screen.getByLabel('City').pressSequentially('W')).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      message: expect.stringContaining('"focus" action'),
    });
    expect(locate).not.toHaveBeenCalled();
  });

  it('refuses a Secret with INVALID_ARGUMENT and points at fill, without touching the engine', async () => {
    const { screen, locate, log, steps } = screenOver();
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
    const { screen } = screenOver();
    const city = screen.getByLabel('City');
    expect(() => city.pressSequentially(42 as unknown as string)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(() => city.pressSequentially('W', { delay: -1 })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(() => city.pressSequentially('W', { delay: Number.NaN })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(() => city.pressSequentially('W', { delayMs: 5 } as never)).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('now "delay"') }),
    );
  });
});

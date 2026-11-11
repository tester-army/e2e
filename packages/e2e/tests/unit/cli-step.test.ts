import { describe, expect, it } from 'vitest';
import { StepGate, stepKeyOf } from '../../src/cli/step.ts';
import type { HeldStep, StepHoldContext, StepPrompt } from '../../src/run/step-hold.ts';

/** How long a prompt ignores keys after it appears. */
const KEY_GUARD_MS = 150;

function step(label: string, testId = 'checkout', target = 'web'): HeldStep {
  return { target, testId, agent: 'default', repeat: 0, title: testId, api: 'app.open', label };
}

/** A gate on a clock the test moves, recording what it showed and whether it asked to stop. */
function gate() {
  let now = 0;
  const shown: (StepPrompt | undefined)[] = [];
  let stops = 0;
  const subject = new StepGate(() => {
    stops += 1;
  }, () => now);
  const context = (signal = new AbortController().signal): StepHoldContext => ({ signal, show: (prompt) => shown.push(prompt) });
  /** Holds `held` and reports, after the microtasks drain, whether it was let through. */
  const hold = (held: HeldStep, signal?: AbortSignal) => {
    let released = false;
    void subject.beforeStep(held, context(signal)).then(() => {
      released = true;
    });
    return { released: async () => { await Promise.resolve(); await Promise.resolve(); return released; } };
  };
  return {
    gate: subject,
    hold,
    /** What the prompt shows now: each held step's number and label, or nothing. */
    showing: () => shown.at(-1)?.steps.map((held) => `${held.number} ${held.step.label}`).join(' + '),
    shown,
    stops: () => stops,
    later: (ms = KEY_GUARD_MS) => {
      now += ms;
    },
  };
}

describe('stepKeyOf', () => {
  it('maps the watch-style keys, Escape to stop, and the control keys raw mode delivers', () => {
    expect(stepKeyOf({ name: 'return', ctrl: false })).toBe('continue');
    expect(stepKeyOf({ name: 'n', ctrl: false })).toBe('test');
    expect(stepKeyOf({ name: 'a', ctrl: false })).toBe('rest');
    expect(stepKeyOf({ name: 'h', ctrl: false })).toBe('help');
    expect(stepKeyOf({ name: 'q', ctrl: false })).toBe('stop');
    expect(stepKeyOf({ name: 'escape', ctrl: false })).toBe('stop');
    expect(stepKeyOf({ name: 'c', ctrl: true })).toBe('interrupt');
    expect(stepKeyOf({ name: 'z', ctrl: true })).toBe('suspend');
    expect(stepKeyOf({ name: 'c', ctrl: false })).toBeUndefined();
  });
});

describe('StepGate', () => {
  it('runs the first step of the run at once and holds the next until c, then takes the prompt down', async () => {
    const { gate: subject, hold, showing, shown, later } = gate();
    expect(await hold(step('/')).released()).toBe(true);
    expect(shown).toEqual([]);
    const second = hold(step('/cart'));
    expect(await second.released()).toBe(false);
    expect(showing()).toBe('2 /cart');
    later();
    subject.press('continue');
    expect(await second.released()).toBe(true);
    expect(showing()).toBeUndefined();
  });

  it('ignores a key pressed before the prompt has been up for the guard', async () => {
    const { gate: subject, hold, later } = gate();
    await hold(step('/')).released();
    const held = hold(step('/cart'));
    later(KEY_GUARD_MS - 1);
    subject.press('continue');
    expect(await held.released()).toBe(false);
    later(1);
    subject.press('continue');
    expect(await held.released()).toBe(true);
  });

  it('asks to stop on Ctrl-C at once, guard or no prompt, and on q only at a prompt', async () => {
    const { gate: subject, hold, stops, later } = gate();
    subject.press('interrupt');
    expect(stops()).toBe(1);
    subject.press('stop');
    expect(stops()).toBe(1);
    await hold(step('/')).released();
    hold(step('/cart'));
    subject.press('interrupt');
    expect(stops()).toBe(2);
    later();
    subject.press('stop');
    expect(stops()).toBe(3);
  });

  it('shows steps held together in one prompt and runs them on one key, so a wait never outlives its action', async () => {
    const { gate: subject, hold, showing, later } = gate();
    await hold(step('/')).released();
    const waits = hold(step('/api/orders'));
    expect(showing()).toBe('2 /api/orders');
    const acts = hold(step('Place order'));
    expect(showing()).toBe('2 /api/orders + 3 Place order');
    later();
    subject.press('continue');
    expect([await waits.released(), await acts.released()]).toEqual([true, true]);
    expect(showing()).toBeUndefined();
  });

  it('lists every key on h until h again, and keeps it for the next prompt', async () => {
    const { gate: subject, hold, shown, later } = gate();
    await hold(step('/')).released();
    const held = hold(step('/cart'));
    later();
    subject.press('help');
    expect(await held.released()).toBe(false);
    expect(shown.at(-1)).toMatchObject({ steps: [{ number: 2 }], help: true });
    subject.press('continue');
    hold(step('/pay'));
    expect(shown.at(-1)).toMatchObject({ steps: [{ number: 3 }], help: true });
    later();
    subject.press('help');
    expect(shown.at(-1)).toMatchObject({ steps: [{ number: 3 }], help: false });
  });

  it('lets the rest of one test through on n, and holds again at the next test or target', async () => {
    const { gate: subject, hold, later } = gate();
    await hold(step('/')).released();
    hold(step('/cart'));
    later();
    subject.press('test');
    expect(await hold(step('/pay')).released()).toBe(true);
    expect(await hold(step('/', 'checkout', 'mobile')).released()).toBe(false);
  });

  it('lets every step through after a', async () => {
    const { gate: subject, hold, later } = gate();
    await hold(step('/')).released();
    const held = hold(step('/cart'));
    later();
    subject.press('rest');
    expect(await held.released()).toBe(true);
    expect(await hold(step('/', 'profile')).released()).toBe(true);
  });

  it('never prompts for a hold that ended before it arrived', async () => {
    const { hold, shown } = gate();
    await hold(step('/')).released();
    const ended = new AbortController();
    ended.abort();
    expect(await hold(step('/late'), ended.signal).released()).toBe(true);
    expect(shown).toEqual([]);
  });

  it('drops a prompt whose hold ended and shows the next one', async () => {
    const { hold, showing } = gate();
    await hold(step('/')).released();
    const ended = new AbortController();
    hold(step('/gone'), ended.signal);
    hold(step('/next'));
    ended.abort();
    expect(showing()).toBe('3 /next');
  });
});

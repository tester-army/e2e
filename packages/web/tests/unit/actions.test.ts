/**
 * Action dispatch and classification: every LocatorAction kind the agent and
 * the screen tier send lands on the right Playwright call, and every
 * Playwright failure lands on the right contract code (the table in
 * support.ts).
 */

import type { Locator as PwLocator, Page } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { EngineError, TestError, type LocatorAction } from 'e2e/engine';
import { classifyActionError, dispatchLocatorAction, dispatchPointerAction } from '../../src/actions.ts';
import type { ActionTarget } from '../../src/support.ts';

vi.mock('node:timers/promises', () => ({
  setTimeout: (ms: number, value?: unknown, options?: { signal?: AbortSignal }) =>
    new Promise((resolve, reject) => {
      if (options?.signal?.aborted) {
        reject(options.signal.reason ?? new Error('aborted'));
        return;
      }
      const timer = globalThis.setTimeout(() => resolve(value), ms);
      options?.signal?.addEventListener(
        'abort',
        () => {
          globalThis.clearTimeout(timer);
          reject(options?.signal?.reason ?? new Error('aborted'));
        },
        { once: true },
      );
    }),
}));

function pwTimeout(callLog: readonly string[]): Error {
  const error = new Error(`locator.click: Timeout 5000ms exceeded.\nCall log:\n${callLog.map((line) => `  - ${line}`).join('\n')}\n`);
  error.name = 'TimeoutError';
  return error;
}

const PRE_DISPATCH_LOG = [
  "waiting for getByRole('button')",
  'locator resolved to <button>Go</button>',
  'attempting click action',
  'waiting for element to be visible, enabled and stable',
  'element is not stable',
  'retrying click action',
];

const POST_DISPATCH_LOG = [
  ...PRE_DISPATCH_LOG.slice(0, 4),
  'element is visible, enabled and stable',
  'scrolling into view if needed',
  'done scrolling',
  'performing click action',
  'click action done',
  'waiting for scheduled navigations to finish',
];

const TAP: LocatorAction = { kind: 'tap' };

describe('classifyActionError', () => {
  it('passes classified errors through untouched, whatever their class', () => {
    const engine = new EngineError('NODE_STALE', 'gone', { retryable: true });
    expect(classifyActionError(engine, TAP)).toBe(engine);
    const runner = new TestError('INVALID_ARGUMENT', 'bad');
    expect(classifyActionError(runner, TAP)).toBe(runner);
  });

  it.each([
    ['strict mode violation: 2 elements', 'NODE_STALE', true],
    ['strict mode violation: 2 elements\nCall log:\n  - move and down action done', 'ACTION_MAY_HAVE_COMMITTED', false],
    ["strict mode violation: getByText('performing click action') resolved to 2 elements:\n    1) <p>click action done</p>\nCall log:\n  - waiting for getByText('performing click action')", 'NODE_STALE', true],
    ['element is detached from the DOM', 'NODE_STALE', true],
    ['Element is not an <input>, <textarea> or [contenteditable] element', 'NOT_ACTIONABLE', false],
    ['Target page, context or browser has been closed', 'ENGINE_FAILURE', false],
  ] as const)('maps "%s" to %s', (text, code, retryable) => {
    expect(classifyActionError(new Error(text), TAP)).toMatchObject({ code, retryable });
  });

  it('maps a timeout whose log ends before the dispatch to NOT_ACTIONABLE', () => {
    const error = classifyActionError(pwTimeout(PRE_DISPATCH_LOG), TAP);
    expect(error).toMatchObject({ code: 'NOT_ACTIONABLE', retryable: false });
    expect(error.message).toContain('tap did not become actionable');
  });

  it('cuts a not-actionable timeout to its headline and the last blocker the log names', () => {
    const covered = [
      ...PRE_DISPATCH_LOG.slice(0, 4),
      'element is visible, enabled and stable',
      '<div class="toast">…</div> intercepts pointer events',
      'retrying click action',
      'waiting 100ms',
      '<div data-popover="true">…</div> intercepts pointer events',
      'retrying click action',
    ];
    expect(classifyActionError(pwTimeout(covered), TAP).message).toBe(
      'tap did not become actionable in time: locator.click: Timeout 5000ms exceeded. <div data-popover="true">…</div> intercepts pointer events',
    );
    expect(classifyActionError(pwTimeout(PRE_DISPATCH_LOG), TAP).message).toBe(
      'tap did not become actionable in time: locator.click: Timeout 5000ms exceeded. element is not stable',
    );
    const compressed = new Error(
      'locator.click: Timeout 5000ms exceeded.\nCall log:\n  - attempting click action\n    2 × waiting for element to be visible, enabled and stable\n      - element is not enabled\n    - retrying click action\n',
    );
    expect(classifyActionError(compressed, TAP).message).toBe(
      'tap did not become actionable in time: locator.click: Timeout 5000ms exceeded. element is not enabled',
    );
  });

  it('keeps a not-actionable timeout whole when its log names no blocker', () => {
    for (const log of [["waiting for getByRole('button')"], ["waiting for getByText('element is not visible')"]]) {
      const waiting = pwTimeout(log);
      expect(classifyActionError(waiting, TAP).message).toBe(`tap did not become actionable in time: ${waiting.message}`);
    }
  });

  it('maps a timeout whose log reached the dispatch to ACTION_MAY_HAVE_COMMITTED', () => {
    const error = classifyActionError(pwTimeout(POST_DISPATCH_LOG), TAP);
    expect(error).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
    expect(error.message).toContain('after its input was dispatched');
  });

  it('treats a log that stopped at "performing" as uncertain: the input may be in flight', () => {
    const inFlight = POST_DISPATCH_LOG.slice(0, POST_DISPATCH_LOG.indexOf('performing click action') + 1);
    expect(classifyActionError(pwTimeout(inFlight), TAP)).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
  });

  it('treats an action the operation deadline cut off as uncertain: Playwright never said whether the input landed', () => {
    const cut = new EngineError('OPERATION_TIMEOUT', 'tap timed out', { retryable: false });
    expect(classifyActionError(cut, TAP)).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false, cause: cut });
  });

  it('treats a press that timed out waiting for the navigation its key started as uncertain', () => {
    const error = new Error(
      'locator.press: Timeout 2000ms exceeded.\nCall log:\n  - waiting for locator(\'#q\')\n    - locator resolved to <input id="q" name="q"/>\n  - elementHandle.press("Enter")\n',
    );
    error.name = 'TimeoutError';
    expect(classifyActionError(error, { kind: 'press', key: 'Enter' })).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
  });

  it('keeps a bare timeout without a call log a plain actionability miss', () => {
    const error = new Error('Timeout 5000ms exceeded');
    error.name = 'TimeoutError';
    expect(classifyActionError(error, { kind: 'press', key: 'Enter' })).toMatchObject({ code: 'NOT_ACTIONABLE' });
  });

  it('never echoes a sensitive fill value, in the message or through the cause', () => {
    const secret = 'hunter2-plaintext';
    const raw = new Error(`locator.fill("${secret}"): Element is not an <input>, <textarea> or [contenteditable] element`);
    const error = classifyActionError(raw, { kind: 'fill', value: secret, sensitive: true });
    expect(error).toMatchObject({ code: 'NOT_ACTIONABLE' });
    expect(error.message).not.toContain(secret);
    expect(error.message).toContain('[redacted]');
    expect(error.cause).toBeUndefined();
  });

  it('keeps the raw cause for an ordinary fill', () => {
    const raw = new Error('Element is not an <input>');
    const error = classifyActionError(raw, { kind: 'fill', value: 'gamma', sensitive: false });
    expect(error.cause).toBe(raw);
  });
});

/** A locator stub recording every action call; the swipe path also needs a box and a page. */
function stubLocator(box = { x: 10, y: 20, width: 200, height: 100 }) {
  const wheel = vi.fn(async (_x: number, _y: number) => undefined);
  const locator = {
    click: vi.fn(async () => undefined),
    dblclick: vi.fn(async () => undefined),
    fill: vi.fn(async () => undefined),
    press: vi.fn(async () => undefined),
    hover: vi.fn(async () => undefined),
    focus: vi.fn(async () => undefined),
    scrollIntoViewIfNeeded: vi.fn(async () => undefined),
    selectOption: vi.fn(async () => undefined),
    setInputFiles: vi.fn(async () => undefined),
    dragTo: vi.fn(async () => undefined),
    boundingBox: vi.fn(async () => box),
    page: () => ({ viewportSize: () => ({ width: 1280, height: 720 }), mouse: { wheel } }),
  };
  const target: ActionTarget = { kind: 'locator', locator: locator as unknown as PwLocator };
  return { locator, target, wheel };
}

describe('dispatchLocatorAction', () => {
  const lookup = () => {
    throw new Error('no second target in these cases');
  };

  it.each([
    [{ kind: 'longPress', durationMs: 900 }, 'click', [{ timeout: 7, delay: 900 }]],
    [{ kind: 'clear' }, 'fill', ['', { timeout: 7 }]],
    [{ kind: 'selectOption', value: 'Blue' }, 'selectOption', [{ label: 'Blue' }, { timeout: 7 }]],
    [{ kind: 'selectOption', value: { index: 2 } }, 'selectOption', [{ index: 2 }, { timeout: 7 }]],
  ] as const satisfies readonly (readonly [LocatorAction, string, readonly unknown[]])[])(
    'dispatches %j to locator.%s',
    async (action, method, args) => {
      const { locator, target } = stubLocator();
      await dispatchLocatorAction(target, action, 7, lookup);
      const spy = locator[method as keyof typeof locator] as ReturnType<typeof vi.fn>;
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]).toEqual(args);
    },
  );

  it('scrolls a node with a wheel gesture sized by its own box: the agent node scroll', async () => {
    const { locator, target, wheel } = stubLocator({ x: 0, y: 0, width: 400, height: 300 });
    await dispatchLocatorAction(target, { kind: 'swipe', direction: 'down' }, 7, lookup);
    expect(locator.hover).toHaveBeenCalledWith({ timeout: 7 });
    expect(wheel).toHaveBeenCalledWith(0, 150);

    await dispatchLocatorAction(target, { kind: 'swipe', direction: 'left', momentum: 'fast' }, 7, lookup);
    expect(wheel).toHaveBeenLastCalledWith(-600, 0);
  });

  it('reports a node without a box as NOT_ACTIONABLE on swipe', async () => {
    const { locator, target } = stubLocator();
    locator.boundingBox.mockResolvedValueOnce(null as never);
    await expect(
      dispatchLocatorAction(target, { kind: 'swipe', direction: 'up' }, 7, lookup),
    ).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' });
  });

  it('uses Playwright drag when both sides are locators', async () => {
    const source = stubLocator();
    const destination = stubLocator();
    await dispatchLocatorAction(
      source.target,
      { kind: 'dragTo', target: { id: 'n2', revision: 'r' } },
      7,
      () => destination.target,
    );
    expect(source.locator.dragTo).toHaveBeenCalledWith(destination.target.locator, { timeout: 7 });
  });
});

describe('dispatchPointerAction', () => {
  /** A page stub whose mouse records every call in order. */
  function stubPage() {
    const calls: string[] = [];
    const mouse = {
      move: async (x: number, y: number) => {
        calls.push(`move ${x},${y}`);
      },
      down: async () => { calls.push('down'); },
      up: async () => { calls.push('up'); },
      click: async (x: number, y: number, options?: { button?: string; delay?: number }) => {
        calls.push(`click ${x},${y}${options?.button === undefined ? '' : ` ${options.button}`}${options?.delay === undefined ? '' : ` ${options.delay}ms`}`);
      },
      dblclick: async (x: number, y: number) => { calls.push(`dblclick ${x},${y}`); },
      wheel: async (dx: number, dy: number) => { calls.push(`wheel ${dx},${dy}`); },
    };
    const page = { mouse, viewportSize: () => ({ width: 800, height: 600 }) } as unknown as Page;
    return { page, calls };
  }

  it('taps, double-taps, secondary-taps, and long-presses at the point as given', async () => {
    const { page, calls } = stubPage();
    await dispatchPointerAction(page, { x: 10, y: 20 }, { kind: 'tap' });
    await dispatchPointerAction(page, { x: 10, y: 20 }, { kind: 'doubleTap' });
    await dispatchPointerAction(page, { x: 10, y: 20 }, { kind: 'secondaryTap' });
    await dispatchPointerAction(page, { x: 10, y: 20 }, { kind: 'longPress', durationMs: 700 });
    expect(calls).toEqual(['click 10,20', 'dblclick 10,20', 'click 10,20 right', 'click 10,20 700ms']);
  });

  it('rounds a fractional point to the nearest CSS pixel: the browser would truncate it a pixel early', async () => {
    const { page, calls } = stubPage();
    await dispatchPointerAction(page, { x: 332, y: 158.875 }, { kind: 'tap' });
    await dispatchPointerAction(page, { x: 10.4, y: 20.5 }, { kind: 'swipeTo', target: { x: 110.6, y: 20.5 } });
    expect(calls).toEqual(['click 332,159', 'move 10,21', 'down', 'move 61,21', 'move 111,21', 'up']);
  });

  it('swipes along a path as a pointer drag: down at the point, through the midpoint, up at the end', async () => {
    const { page, calls } = stubPage();
    await dispatchPointerAction(page, { x: 10, y: 20 }, { kind: 'swipeTo', target: { x: 110, y: 20 } });
    expect(calls).toEqual(['move 10,20', 'down', 'move 60,20', 'move 110,20', 'up']);
  });

  it('swipes along a path with duration as a multi-step drag paced over time', async () => {
    vi.useFakeTimers();
    try {
      const { page, calls } = stubPage();
      const promise = dispatchPointerAction(page, { x: 10, y: 20 }, { kind: 'swipeTo', target: { x: 70, y: 20 }, durationMs: 48 });
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toEqual(['move 10,20', 'down']);
      await vi.advanceTimersByTimeAsync(16);
      expect(calls).toEqual(['move 10,20', 'down', 'move 30,20']);
      await vi.advanceTimersByTimeAsync(16);
      expect(calls).toEqual(['move 10,20', 'down', 'move 30,20', 'move 50,20']);
      await vi.advanceTimersByTimeAsync(16);
      expect(calls).toEqual(['move 10,20', 'down', 'move 30,20', 'move 50,20', 'move 70,20', 'up']);
      await promise;
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops dispatching moves when aborted and releases the mouse', async () => {
    vi.useFakeTimers();
    try {
      const { page, calls } = stubPage();
      const controller = new AbortController();
      const promise = dispatchPointerAction(
        page,
        { x: 10, y: 20 },
        { kind: 'swipeTo', target: { x: 70, y: 20 }, durationMs: 48 },
        controller.signal,
      );
      await vi.advanceTimersByTimeAsync(16);
      expect(calls).toEqual(['move 10,20', 'down', 'move 30,20']);
      controller.abort();
      await expect(promise).rejects.toThrow();
      expect(calls).toEqual(['move 10,20', 'down', 'move 30,20', 'up']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('swipes in a direction as a wheel gesture over the point, sized by the viewport', async () => {
    const { page, calls } = stubPage();
    await dispatchPointerAction(page, { x: 10, y: 20 }, { kind: 'swipe', direction: 'down' });
    expect(calls).toEqual(['move 10,20', 'wheel 0,300']);
  });
});

/**
 * Action dispatch and classification: every LocatorAction kind the agent and
 * the screen tier send lands on the right Playwright call, and every
 * Playwright failure lands on the right contract code (the table in
 * support.ts).
 */

import type { Locator as PwLocator } from 'playwright';
import { describe, expect, it, vi } from 'vitest';
import { BackendError, type LocatorAction } from 'e2e/backend';
import { TestError } from 'e2e/backend';
import { classifyActionError, dispatchLocatorAction } from '../../src/actions.ts';
import type { ActionTarget } from '../../src/support.ts';

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
    const backend = new BackendError('NODE_STALE', 'gone', { retryable: true });
    expect(classifyActionError(backend, TAP)).toBe(backend);
    const runner = new TestError('INVALID_ARGUMENT', 'bad');
    expect(classifyActionError(runner, TAP)).toBe(runner);
  });

  it.each([
    ['strict mode violation: 2 elements', 'BACKEND_FAILURE', false],
    ['element is detached from the DOM', 'NODE_STALE', true],
    ['Element is not attached to the DOM', 'NODE_STALE', true],
    ['Element is not an <input>, <textarea> or [contenteditable] element', 'NOT_ACTIONABLE', false],
    ['Element is not a checkbox', 'NOT_ACTIONABLE', false],
    ['Target page, context or browser has been closed', 'BACKEND_FAILURE', false],
  ] as const)('maps "%s" to %s', (text, code, retryable) => {
    expect(classifyActionError(new Error(text), TAP)).toMatchObject({ code, retryable });
  });

  it('maps a timeout whose log ends before the dispatch to NOT_ACTIONABLE', () => {
    const error = classifyActionError(pwTimeout(PRE_DISPATCH_LOG), TAP);
    expect(error).toMatchObject({ code: 'NOT_ACTIONABLE', retryable: false });
    expect(error.message).toContain('tap did not become actionable');
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
    check: vi.fn(async () => undefined),
    uncheck: vi.fn(async () => undefined),
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
    [{ kind: 'tap' }, 'click', [{ timeout: 7 }]],
    [{ kind: 'doubleTap' }, 'dblclick', [{ timeout: 7 }]],
    [{ kind: 'longPress', durationMs: 900 }, 'click', [{ timeout: 7, delay: 900 }]],
    [{ kind: 'fill', value: 'ada', sensitive: false }, 'fill', ['ada', { timeout: 7 }]],
    [{ kind: 'fill', value: 'hunter2', sensitive: true }, 'fill', ['hunter2', { timeout: 7 }]],
    [{ kind: 'clear' }, 'fill', ['', { timeout: 7 }]],
    [{ kind: 'press', key: 'Enter' }, 'press', ['Enter', { timeout: 7 }]],
    [{ kind: 'check' }, 'check', [{ timeout: 7 }]],
    [{ kind: 'uncheck' }, 'uncheck', [{ timeout: 7 }]],
    [{ kind: 'focus' }, 'focus', [{ timeout: 7 }]],
    [{ kind: 'hover' }, 'hover', [{ timeout: 7 }]],
    [{ kind: 'scrollIntoView' }, 'scrollIntoViewIfNeeded', [{ timeout: 7 }]],
    [{ kind: 'selectOption', value: 'Blue' }, 'selectOption', [{ label: 'Blue' }, { timeout: 7 }]],
    [{ kind: 'selectOption', value: { index: 2 } }, 'selectOption', [{ index: 2 }, { timeout: 7 }]],
    [{ kind: 'selectOption', value: { label: 'Red' } }, 'selectOption', [{ label: 'Red' }, { timeout: 7 }]],
    [{ kind: 'setInputFiles', paths: ['/tmp/a.txt'] }, 'setInputFiles', [['/tmp/a.txt'], { timeout: 7 }]],
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

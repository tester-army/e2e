/**
 * Native dialog routing: which handler answers, how registrations come and
 * go, and how a failure on the unawaited dialog path reaches the next step.
 */

import type { Dialog as PwDialog } from 'playwright-core';
import { TestError, type AppLogEntry } from 'e2e/engine';
import { describe, expect, it, vi } from 'vitest';
import { DialogRouter } from '../../src/dialogs.ts';
import { ErrorLatch } from '../../src/support.ts';

function fakeDialog(text = 'are you sure?', type = 'confirm') {
  const accept = vi.fn(async (_text?: string) => undefined);
  const dismiss = vi.fn(async () => undefined);
  const dialog = { type: () => type, message: () => text, accept, dismiss } as unknown as PwDialog;
  return { dialog, accept, dismiss };
}

/** A router whose surface reports who acted last, with the app log it tells. */
function routerFor(actor: 'agent' | 'test') {
  const log: AppLogEntry[] = [];
  const router = new DialogRouter(new ErrorLatch(), { agentActed: () => actor === 'agent', log: (entry) => log.push(entry) });
  return { router, log };
}

describe('DialogRouter', () => {
  it('routes to the newest handler and falls back once it unsubscribes', async () => {
    const router = new DialogRouter();
    const first = vi.fn();
    const second = vi.fn();
    router.add(first);
    const unsubscribe = router.add(second);

    await router.dispatch(fakeDialog().dialog);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();

    unsubscribe();
    await router.dispatch(fakeDialog().dialog);
    expect(first).toHaveBeenCalledTimes(1);
  });

  it('tracks registrations by identity: the same handler twice, unsubscribed once, stays', async () => {
    const router = new DialogRouter();
    const handler = vi.fn((dialog: { accept(): Promise<void> }) => dialog.accept());
    const unsubscribeFirst = router.add(handler);
    router.add(handler);
    unsubscribeFirst();
    unsubscribeFirst();

    const { dialog } = fakeDialog();
    await router.dispatch(dialog);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(() => router.throwPending()).not.toThrow();
  });

  it('applies the accept and dismiss shorthands and passes the message through', async () => {
    const router = new DialogRouter();
    router.add('accept');
    const accepted = fakeDialog();
    await router.dispatch(accepted.dialog);
    expect(accepted.accept).toHaveBeenCalledTimes(1);

    router.add('dismiss');
    const dismissed = fakeDialog();
    await router.dispatch(dismissed.dialog);
    expect(dismissed.dismiss).toHaveBeenCalledTimes(1);

    const seen: string[] = [];
    router.add((dialog) => {
      seen.push(dialog.message);
      return dialog.accept('yes');
    });
    const custom = fakeDialog('name?');
    await router.dispatch(custom.dialog);
    expect(seen).toEqual(['name?']);
    expect(custom.accept).toHaveBeenCalledWith('yes');
  });

  it('dismisses a dialog its handler left undecided and latches INVALID_STATE naming the handler', async () => {
    const router = new DialogRouter();
    router.add(() => {
      // Looked, decided nothing: the page would stay blocked behind the dialog.
    });
    const { dialog, dismiss } = fakeDialog('are you sure?');
    await router.dispatch(dialog);
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(() => router.throwPending()).toThrowError(
      expect.objectContaining({
        code: 'INVALID_STATE',
        message: expect.stringContaining('returned without calling accept or dismiss'),
      }),
    );
  });

  it('dismisses an unhandled dialog and latches INVALID_STATE, thrown exactly once', async () => {
    const router = new DialogRouter();
    const { dialog, dismiss } = fakeDialog('unexpected');
    await router.dispatch(dialog);
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(() => router.throwPending()).toThrowError(
      expect.objectContaining({ code: 'INVALID_STATE', message: expect.stringContaining('unexpected') }),
    );
    expect(() => router.throwPending()).not.toThrow();
  });

  it('latches a failing handler as ENGINE_FAILURE, thrown once', async () => {
    const router = new DialogRouter();
    router.add(() => {
      throw new Error('handler exploded');
    });
    const { dialog, dismiss } = fakeDialog();
    await router.dispatch(dialog);
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(() => router.throwPending()).toThrowError(
      expect.objectContaining({ code: 'ENGINE_FAILURE', message: expect.stringContaining('handler exploded') }),
    );

    expect(() => router.throwPending()).not.toThrow();
  });

  it('dismisses a dialog when accepting rejects and leaves it unanswered', async () => {
    const router = new DialogRouter();
    const { dialog, accept, dismiss } = fakeDialog();
    accept.mockRejectedValueOnce(new Error('accept failed'));
    router.add((native) => native.accept());
    await router.dispatch(dialog);
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(() => router.throwPending()).toThrowError(expect.objectContaining({ code: 'ENGINE_FAILURE' }));
  });

  it('accepts a void handler that starts an answer without awaiting it', async () => {
    const router = new DialogRouter();
    const { dialog, accept, dismiss } = fakeDialog();
    router.add((native) => { void native.accept(); });
    await router.dispatch(dialog);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(dismiss).not.toHaveBeenCalled();
    expect(() => router.throwPending()).not.toThrow();
  });

  it('latches a classified handler failure as it was: an assertion stays ASSERTION_FAILED', async () => {
    const router = new DialogRouter();
    const failure = new TestError('ASSERTION_FAILED', 'expected the other message');
    router.add(async (dialog) => {
      await dialog.accept();
      throw failure;
    });
    await router.dispatch(fakeDialog().dialog);
    expect(() => router.throwPending()).toThrow(failure);
  });

  it('shares one latch with its owner, so either side observes the failure', async () => {
    const latch = new ErrorLatch();
    const router = new DialogRouter(latch);
    await router.dispatch(fakeDialog().dialog);
    expect(() => latch.throwPending()).toThrowError(expect.objectContaining({ code: 'INVALID_STATE' }));
    expect(() => router.throwPending()).not.toThrow();
  });
});

describe('a dialog no handler takes', () => {
  it.each([
    ['alert', 'Saved', 'alert dialog "Saved" accepted for the agent'],
    ['confirm', 'Delete this label?', 'confirm dialog "Delete this label?" accepted for the agent'],
    ['beforeunload', '', 'beforeunload dialog accepted for the agent'],
  ] as const)('after an agent operation: accepts the %s, tells the app log, and fails nothing', async (type, text, line) => {
    const { router, log } = routerFor('agent');
    const native = fakeDialog(text, type);
    await router.dispatch(native.dialog);
    expect(native.accept).toHaveBeenCalledOnce();
    expect(native.dismiss).not.toHaveBeenCalled();
    expect(log).toEqual([{ source: 'system', level: 'info', text: line }]);
    expect(() => router.throwPending()).not.toThrow();
  });

  it('after an agent operation: dismisses a prompt, whose text the agent cannot see to answer', async () => {
    const { router, log } = routerFor('agent');
    const native = fakeDialog('New name?\n(max 20 characters)', 'prompt');
    await router.dispatch(native.dialog);
    expect(native.dismiss).toHaveBeenCalledOnce();
    expect(native.accept).not.toHaveBeenCalled();
    expect(log).toEqual([{ source: 'system', level: 'info', text: 'prompt dialog "New name? (max 20 characters)" dismissed for the agent' }]);
    expect(() => router.throwPending()).not.toThrow();
  });

  it('after a test operation: dismisses it and latches INVALID_STATE, as with no surface to ask', async () => {
    const { router, log } = routerFor('test');
    const native = fakeDialog('unexpected');
    await router.dispatch(native.dialog);
    expect(native.dismiss).toHaveBeenCalledOnce();
    expect(log).toEqual([]);
    expect(() => router.throwPending()).toThrowError(expect.objectContaining({ code: 'INVALID_STATE' }));
  });

  it("leaves a registered handler in charge after an agent operation", async () => {
    const { router, log } = routerFor('agent');
    router.add('dismiss');
    const native = fakeDialog('Delete this label?');
    await router.dispatch(native.dialog);
    expect(native.dismiss).toHaveBeenCalledOnce();
    expect(native.accept).not.toHaveBeenCalled();
    expect(log).toEqual([]);
  });

  it('tells nothing and fails nothing when the dialog is gone before the agent answer lands', async () => {
    const { router, log } = routerFor('agent');
    const native = fakeDialog('Saved', 'alert');
    native.accept.mockRejectedValueOnce(new Error('Target page, context or browser has been closed'));
    await router.dispatch(native.dialog);
    expect(log).toEqual([]);
    expect(() => router.throwPending()).not.toThrow();
  });
});

describe('ErrorLatch', () => {
  const budget = () => ({ timeoutMs: 1_000, signal: new AbortController().signal });

  it('keeps the first error until it is thrown, then forgets it', () => {
    const latch = new ErrorLatch();
    const first = new Error('first');
    latch.latch(first);
    latch.latch(new Error('second'));
    expect(() => latch.throwPending()).toThrow(first);
    expect(() => latch.throwPending()).not.toThrow();
  });

  it('settles with what a tracked path still running latches once it finishes', async () => {
    const latch = new ErrorLatch();
    const router = new DialogRouter(latch);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    router.add(async (dialog) => {
      await dialog.accept();
      await waiting;
      throw new TestError('ASSERTION_FAILED', 'late');
    });
    void router.dispatch(fakeDialog().dialog);
    const settling = latch.settle(budget());
    release();
    await expect(settling).rejects.toThrowError(expect.objectContaining({ code: 'ASSERTION_FAILED' }));
    await expect(latch.settle(budget())).resolves.toBeUndefined();
  });

  it('fails closed with CLEANUP_TIMEOUT naming a handler that outlives the budget, and drops what it throws later', async () => {
    const latch = new ErrorLatch();
    const router = new DialogRouter(latch);
    router.add(async (dialog) => {
      await dialog.accept();
      await new Promise((resolve) => setTimeout(resolve, 100));
      throw new TestError('ASSERTION_FAILED', 'too late to count');
    });
    const dispatched = router.dispatch(fakeDialog().dialog);
    await expect(latch.settle({ timeoutMs: 20, signal: new AbortController().signal })).rejects.toThrowError(
      expect.objectContaining({
        code: 'CLEANUP_TIMEOUT',
        category: 'infrastructure',
        message: expect.stringContaining('a dialog handler was still running'),
      }),
    );
    await dispatched;
    expect(() => latch.throwPending()).not.toThrow();
    await expect(latch.settle(budget())).resolves.toBeUndefined();
  });

  it('waits only for the paths running when it was called, so one starting during the wait is no timeout', async () => {
    const latch = new ErrorLatch();
    let startNext!: () => void;
    const first = new Promise<void>((resolve) => {
      startNext = resolve;
    });
    latch.track('route', first);
    void first.then(() => latch.track('route', new Promise<void>((resolve) => setTimeout(resolve, 50))));
    const settling = latch.settle(budget());
    startNext();
    await expect(settling).resolves.toBeUndefined();
  });

  it('reports a latched error at once, ahead of handlers still running, and names every kind still running at the timeout', async () => {
    const latch = new ErrorLatch();
    latch.latch(new TestError('ASSERTION_FAILED', 'landed in time'));
    latch.track('route', new Promise<void>(() => undefined));
    latch.track('dialog', new Promise<void>(() => undefined));
    await expect(latch.settle({ timeoutMs: 60_000, signal: new AbortController().signal })).rejects.toThrowError(
      expect.objectContaining({ code: 'ASSERTION_FAILED' }),
    );
    const bare = new ErrorLatch();
    bare.track('route', new Promise<void>(() => undefined));
    bare.track('dialog', new Promise<void>(() => undefined));
    await expect(bare.settle({ timeoutMs: 20, signal: new AbortController().signal })).rejects.toThrowError(
      expect.objectContaining({ message: expect.stringContaining('a dialog and route handler was still running') }),
    );
  });
});

describe('native dialog kind', () => {
  it.each(['alert', 'confirm', 'prompt', 'beforeunload'] as const)('exposes %s independently of identical messages', async (kind) => {
    const router = new DialogRouter();
    const native = fakeDialog('same message');
    native.dialog.type = () => kind;
    const seen: string[] = [];
    router.add(async dialog => { seen.push(dialog.type); await dialog.dismiss(); });
    await router.dispatch(native.dialog);
    expect(seen).toEqual([kind]);
    expect(native.dismiss).toHaveBeenCalledOnce();
    expect(() => router.throwPending()).not.toThrow();
  });
});

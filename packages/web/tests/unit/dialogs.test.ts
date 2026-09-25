/**
 * Native dialog routing: which handler answers, how registrations come and
 * go, and how a failure on the unawaited dialog path reaches the next step.
 */

import type { Dialog as PwDialog } from 'playwright';
import { TestError } from 'e2e/engine';
import { describe, expect, it, vi } from 'vitest';
import { DialogRouter } from '../../src/dialogs.ts';
import { ErrorLatch } from '../../src/support.ts';

function fakeDialog(text = 'are you sure?') {
  const accept = vi.fn(async (_text?: string) => undefined);
  const dismiss = vi.fn(async () => undefined);
  const dialog = { type: () => 'confirm', message: () => text, accept, dismiss } as unknown as PwDialog;
  return { dialog, accept, dismiss };
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
    await router.dispatch(fakeDialog().dialog);
    expect(() => router.throwPending()).toThrowError(
      expect.objectContaining({ code: 'ENGINE_FAILURE', message: expect.stringContaining('handler exploded') }),
    );

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

  it('settles within the budget when a tracked path never finishes', async () => {
    const latch = new ErrorLatch();
    latch.track(new Promise<void>(() => undefined));
    await expect(latch.settle({ timeoutMs: 20, signal: new AbortController().signal })).resolves.toBeUndefined();
  });
});

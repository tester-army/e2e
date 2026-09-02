/**
 * Native dialog routing: which handler answers, how registrations come and
 * go, and how a failure on the unawaited dialog path reaches the next step.
 */

import type { Dialog as PwDialog } from 'playwright';
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
    const handler = vi.fn();
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

  it('latches a failing handler as BACKEND_FAILURE and clears it on reset', async () => {
    const router = new DialogRouter();
    router.add(() => {
      throw new Error('handler exploded');
    });
    await router.dispatch(fakeDialog().dialog);
    expect(() => router.throwPending()).toThrowError(
      expect.objectContaining({ code: 'BACKEND_FAILURE', message: expect.stringContaining('handler exploded') }),
    );

    await router.dispatch(fakeDialog().dialog);
    router.reset();
    expect(() => router.throwPending()).not.toThrow();
    // reset also forgot the failing handler: the next dialog is unhandled.
    const { dialog, dismiss } = fakeDialog();
    await router.dispatch(dialog);
    expect(dismiss).toHaveBeenCalledTimes(1);
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
  it('keeps the first error until it is thrown, then forgets it', () => {
    const latch = new ErrorLatch();
    const first = new Error('first');
    latch.latch(first);
    latch.latch(new Error('second'));
    expect(() => latch.throwPending()).toThrow(first);
    expect(() => latch.throwPending()).not.toThrow();
  });
});

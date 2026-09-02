/**
 * Native dialog routing for one attempt. Handlers are registered by the `web`
 * fixture; the surface owns the router so a dialog that fires before a test
 * ever touches `web` is still accounted for instead of silently dismissed.
 */

import type { Dialog as PwDialog } from 'playwright';
import { BackendError } from 'e2e/backend';
import { ErrorLatch, message } from './support.ts';

/** A native dialog as a test's handler sees it. */
export interface Dialog {
  readonly message: string;
  /** Accepts the dialog once. */
  accept(text?: string): Promise<void>;
  /** Dismisses the dialog once. */
  dismiss(): Promise<void>;
}

export type DialogHandler = 'accept' | 'dismiss' | ((dialog: Dialog) => void | Promise<void>);

interface Registration {
  readonly handler: DialogHandler;
}

export class DialogRouter {
  private registrations: Registration[] = [];

  /**
   * `latch` is shared with the surface: a dialog failure and a route-handler
   * failure surface through one check at the next step.
   */
  constructor(private readonly latch: ErrorLatch = new ErrorLatch()) {}

  /** Forgets every handler and any latched error; called per attempt. */
  reset(): void {
    this.registrations = [];
    this.latch.reset();
  }

  /**
   * Registers a handler (the newest wins) and returns its idempotent
   * unsubscribe. Registrations are tracked by identity, so registering the
   * same handler twice and unsubscribing once leaves one in place.
   */
  add(handler: DialogHandler): () => void {
    const registration: Registration = { handler };
    this.registrations.push(registration);
    return () => {
      this.registrations = this.registrations.filter((entry) => entry !== registration);
    };
  }

  /** Rethrows an error latched by an unhandled or failing dialog handler. */
  throwPending(): void {
    this.latch.throwPending();
  }

  /** Routes one native dialog to the newest registered handler. */
  async dispatch(dialog: PwDialog): Promise<void> {
    const handler = this.registrations.at(-1)?.handler;
    if (handler === undefined) {
      this.latch.latch(
        new BackendError(
          'INVALID_STATE',
          `unhandled ${dialog.type()} dialog: ${dialog.message()}`,
          { retryable: false },
        ),
      );
      await dialog.dismiss().catch(() => undefined);
      return;
    }
    const publicDialog: Dialog = {
      message: dialog.message(),
      accept: async (text) => {
        await dialog.accept(text);
      },
      dismiss: async () => {
        await dialog.dismiss();
      },
    };
    try {
      if (handler === 'accept') await dialog.accept();
      else if (handler === 'dismiss') await dialog.dismiss();
      else await handler(publicDialog);
    } catch (cause) {
      this.latch.latch(
        new BackendError('BACKEND_FAILURE', `dialog handler failed: ${message(cause)}`, {
          retryable: false,
          cause,
        }),
      );
    }
  }
}

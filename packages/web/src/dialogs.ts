/**
 * Native dialog routing for one attempt. Handlers are registered by the `web`
 * fixture; the surface owns the router so a dialog that fires before a test
 * ever touches `web` is still accounted for instead of silently dismissed.
 */

import type { Dialog as PwDialog } from 'playwright';
import { EngineError } from 'e2e/engine';
import { ErrorLatch, message } from './support.ts';

/** A native dialog as a test's handler sees it. */
export interface Dialog {
  /** Which `window` call opened it, or `beforeunload` for the leave-page prompt. */
  readonly type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  /** The dialog's text. */
  readonly message: string;
  /** Accepts the dialog once. */
  accept(text?: string): Promise<void>;
  /** Dismisses the dialog once. */
  dismiss(): Promise<void>;
}

export type DialogHandler = 'accept' | 'dismiss' | ((dialog: Dialog) => void | Promise<void>);

/** The kinds a handler may see, as `Dialog['type']` spells them; `dialogType` admits nothing else. */
const DIALOG_TYPES = Object.freeze(['alert', 'confirm', 'prompt', 'beforeunload'] as const satisfies readonly Dialog['type'][]);

/** Playwright types `dialog.type()` as a string; only the four kinds it documents pass, anything else is undefined. */
function dialogType(dialog: PwDialog): Dialog['type'] | undefined {
  const type = dialog.type();
  return (DIALOG_TYPES as readonly string[]).includes(type) ? (type as Dialog['type']) : undefined;
}

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
    const type = dialogType(dialog);
    if (type === undefined) {
      // A kind the contract does not name cannot reach a handler typed on the four it does.
      this.latch.latch(
        new EngineError(
          'ENGINE_FAILURE',
          `dialog of unknown kind "${dialog.type()}": ${dialog.message()}`,
          { retryable: false },
        ),
      );
      await dialog.dismiss().catch(() => undefined);
      return;
    }
    const handler = this.registrations.at(-1)?.handler;
    if (handler === undefined) {
      this.latch.latch(
        new EngineError(
          'INVALID_STATE',
          `unhandled ${dialog.type()} dialog: ${dialog.message()}`,
          { retryable: false },
        ),
      );
      await dialog.dismiss().catch(() => undefined);
      return;
    }
    let decided = false;
    const publicDialog: Dialog = {
      type,
      message: dialog.message(),
      accept: async (text) => {
        decided = true;
        await dialog.accept(text);
      },
      dismiss: async () => {
        decided = true;
        await dialog.dismiss();
      },
    };
    try {
      if (handler === 'accept') await dialog.accept();
      else if (handler === 'dismiss') await dialog.dismiss();
      else {
        await handler(publicDialog);
        // A dialog left open blocks the page, and the failure would surface
        // later as an unrelated action timeout. The handler contract is the
        // same as a route handler's: decide, or the step fails naming you.
        if (!decided) {
          await dialog.dismiss().catch(() => undefined);
          this.latch.latch(
            new EngineError(
              'INVALID_STATE',
              `dialog handler returned without calling accept or dismiss for ${dialog.type()} dialog: ${dialog.message()}`,
              { retryable: false },
            ),
          );
        }
      }
    } catch (cause) {
      this.latch.latch(
        new EngineError('ENGINE_FAILURE', `dialog handler failed: ${message(cause)}`, {
          retryable: false,
          cause,
        }),
      );
    }
  }
}

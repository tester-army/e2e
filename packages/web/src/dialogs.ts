/**
 * Native dialog routing for one attempt. Handlers are registered by the `web`
 * fixture; the surface owns the router so a dialog that fires before a test
 * ever touches `web` is still accounted for instead of silently dismissed.
 *
 * A dialog no handler takes fails the test's next step, unless the agent
 * acted last: native dialogs are outside the page, so the agent never sees
 * one and cannot answer it. The router answers it for the agent the way the
 * action that opened it asked (an alert or a confirm accepted, a page left
 * when the agent navigated away from unsaved changes) and tells the app log.
 * A prompt asks for text the agent never sees, so it is dismissed.
 */

import type { Dialog as PwDialog } from 'playwright-core';
import { EngineError, type AppLogEntry } from 'e2e/engine';
import { ErrorLatch, isClassified, message } from './support.ts';

/** A native dialog as a test's handler sees it. */
export interface Dialog {
  /** The native dialog kind, independent of its message. */
  readonly type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  /** The dialog's text. */
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

/** What the router asks its surface about a dialog no handler takes. */
export interface UnhandledDialogs {
  /** Whether the newest operation on the page was the agent's. */
  readonly agentActed: () => boolean;
  /** The attempt's app log, told each dialog answered for the agent. */
  readonly log: (entry: AppLogEntry) => void;
}

export class DialogRouter {
  private registrations: Registration[] = [];

  /**
   * `latch` is shared with the surface: a dialog failure and a route-handler
   * failure surface through one check at the next step. Without `unhandled`,
   * every dialog no handler takes fails the next step.
   */
  constructor(
    private readonly latch: ErrorLatch = new ErrorLatch(),
    private readonly unhandled?: UnhandledDialogs,
  ) {}

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

  /** Routes one native dialog to the newest registered handler; the attempt end waits for it. */
  dispatch(dialog: PwDialog): Promise<void> {
    const work = this.route(dialog);
    this.latch.track('dialog', work);
    return work;
  }

  private async route(dialog: PwDialog): Promise<void> {
    const handler = this.registrations.at(-1)?.handler;
    if (handler === undefined && this.unhandled?.agentActed() === true) {
      await this.answerForAgent(dialog, this.unhandled);
      return;
    }
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
    let answered = false;
    const publicDialog: Dialog = {
      type: dialog.type() as Dialog['type'],
      message: dialog.message(),
      accept: async (text) => {
        decided = true;
        await dialog.accept(text);
        answered = true;
      },
      dismiss: async () => {
        decided = true;
        await dialog.dismiss();
        answered = true;
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
      // A failed assertion or a policy refusal keeps its code; only an
      // unclassified throw is the engine's to name.
      this.latch.latch(
        isClassified(cause)
          ? cause
          : new EngineError('ENGINE_FAILURE', `dialog handler failed: ${message(cause)}`, {
              retryable: false,
              cause,
            }),
      );
      if (!answered) await dialog.dismiss().catch(() => undefined);
    }
  }

  /**
   * Answers a dialog the agent's action opened and names it in the app log.
   * A dialog the page closed first, or a page that went away, leaves nothing
   * to answer and nothing to tell.
   */
  private async answerForAgent(dialog: PwDialog, unhandled: UnhandledDialogs): Promise<void> {
    const type = dialog.type();
    const accepted = type !== 'prompt';
    try {
      if (accepted) await dialog.accept();
      else await dialog.dismiss();
    } catch {
      return;
    }
    const text = dialog.message().replace(/\s+/g, ' ').trim();
    const quoted = text === '' ? '' : ` ${JSON.stringify(text)}`;
    unhandled.log({
      source: 'system',
      level: 'info',
      text: `${type} dialog${quoted} ${accepted ? 'accepted' : 'dismissed'} for the agent`,
    });
  }
}

/** The running attempt, published for expectations that have no fixture to hang off. */

import { attemptBrand } from '../internal/brands.ts';
import { InfrastructureError } from '../internal/errors.ts';
import { realmSlot } from '../internal/realm-slot.ts';
import type { AttemptBudget } from '../run/budget.ts';
import type { SoftFailures } from './soft.ts';

export interface PublishedAttempt {
  readonly attemptId: string;
  /** Setup tests owe their sessions and may not skip themselves. */
  readonly testKind: 'test' | 'setup';
  /** The config default for a poll's `timeout`. */
  readonly assertionTimeout: number;
  /** Read at call time: the running phase's signal and deadline. */
  readonly budget: AttemptBudget;
  /** Where `expect.soft` keeps its failures until the body settles. */
  readonly soft: SoftFailures;
}

/**
 * `globalThis` hosts the slot: test modules load in isolated module realms
 * and share nothing but globals with the runner, and `expect.poll` has no
 * fixture argument to carry the attempt on, nor has `expect.soft`. One attempt runs at a time per
 * process (the in-process runner is capped at one worker, a child worker
 * runs one unit at a time), so a single slot names it unambiguously.
 * `publishAttempt` refuses a second live attempt rather than trusting that.
 * Standalone hosts (`e2e mcp`) run no test body and never publish.
 */
const slot = realmSlot<PublishedAttempt>(attemptBrand);

/** Names the attempt until `until` fires; a stale clear never removes a newer attempt. */
export function publishAttempt(context: PublishedAttempt, until: AbortSignal): void {
  const current = slot.get(globalThis);
  if (current !== undefined) {
    throw new InfrastructureError(
      'WORKER_PROTOCOL',
      `attempt ${context.attemptId} started while attempt ${current.attemptId} was still running`,
    );
  }
  if (until.aborted) return;
  slot.set(globalThis, context);
  until.addEventListener(
    'abort',
    () => {
      if (slot.get(globalThis) === context) slot.delete(globalThis);
    },
    { once: true },
  );
}

/** The attempt a poll runs inside, or undefined in a standalone script. */
export function currentAttempt(): PublishedAttempt | undefined {
  return slot.get(globalThis);
}

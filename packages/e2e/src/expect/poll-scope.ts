/** Which phase of a test owns an `expect.poll`, so one left running fails that phase and nothing later. */

import { markAbandonedRejection, relocateStack } from '../internal/abandoned.ts';
import { pollScopesBrand } from '../internal/brands.ts';
import { TestError, withHint } from '../internal/errors.ts';
import { realmSlot } from '../internal/realm-slot.ts';

interface RunningPoll {
  readonly label: string;
  readonly stack: string | undefined;
  readonly controller: AbortController;
  promise: Promise<unknown>;
  abandoned: boolean;
}

/**
 * The polls one phase started: a test body with its fixtures and
 * `beforeEach` hooks, one teardown, or one suite hook. A poll is not a step
 * and records nothing; what the scope adds is that a poll the phase did not
 * await ends with the phase instead of failing whatever runs when it times out.
 */
export class PollScope {
  private readonly running = new Set<RunningPoll>();

  /** `owner` completes "... returned before", as in `the test body`; `release` gives up the slot. */
  constructor(
    private readonly owner: string,
    private readonly release: () => void,
  ) {}

  /**
   * Runs one poll, owned by this scope until it settles. `work` receives the
   * signal that cancels it when the scope closes first.
   */
  track<T>(label: string, stack: string | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const poll: RunningPoll = { label, stack, controller: new AbortController(), promise: Promise.resolve(), abandoned: false };
    const promise = (async () => {
      try {
        return await work(poll.controller.signal);
      } catch (cause) {
        if (poll.abandoned) markAbandonedRejection(cause);
        throw cause;
      } finally {
        this.running.delete(poll);
      }
    })();
    poll.promise = promise;
    this.running.add(poll);
    return promise;
  }

  /**
   * Ends the scope when its phase has returned: every poll still running is
   * cancelled and its later rejection observed. Returns the error naming
   * them, at the line of the first, or nothing when every poll had settled.
   * A caller whose phase was cut short (a timeout, a throw) may drop the
   * error: the phase may have been awaiting the poll. Closing twice returns
   * nothing the second time.
   */
  close(): TestError | undefined {
    this.release();
    const polls = [...this.running];
    const [first] = polls;
    if (first === undefined) return undefined;
    for (const poll of polls) this.cancel(poll);
    const more = polls.length > 1 ? ` and ${polls.length - 1} more` : '';
    const error = new TestError(
      'STEP_NOT_AWAITED',
      withHint(`${this.owner} returned before ${first.label}${more} finished`, 'put `await` in front of every expect.poll call'),
    );
    relocateStack(error, first.stack);
    return error;
  }

  private cancel(poll: RunningPoll): void {
    this.running.delete(poll);
    poll.abandoned = true;
    poll.promise.catch(() => undefined);
    poll.controller.abort();
  }
}

const slot = realmSlot<PollScope>(pollScopesBrand);

/**
 * Opens the scope that owns every poll started from now until it closes. The
 * slot lives on `globalThis`, so a test module's copy of `expect` reads the
 * runner's scope. Phases run one at a time per process, so one slot names the
 * owner; work a phase left behind that polls later belongs to the phase
 * running then.
 */
export function openPollScope(owner: string): PollScope {
  const scope = new PollScope(owner, () => {
    if (slot.get(globalThis) === scope) slot.delete(globalThis);
  });
  slot.set(globalThis, scope);
  return scope;
}

/** The scope a poll started now belongs to, or undefined outside any phase (a standalone script). */
export function currentPollScope(): PollScope | undefined {
  return slot.get(globalThis);
}

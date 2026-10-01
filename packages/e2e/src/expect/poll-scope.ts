/** Which phase of a test owns an `expect.poll`, so one left running fails that phase and nothing later. */

import { AsyncLocalStorage } from 'node:async_hooks';
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
  private closed = false;

  /** `owner` completes "... returned before", as in `the test body`. */
  constructor(private readonly owner: string) {}

  /**
   * Runs one poll, owned by this scope until it settles. `work` receives the
   * signal that cancels it when the scope closes first. A poll started after
   * the scope closed, by work its phase left running (a body past its
   * timeout), is cancelled before its first read: it belongs to no phase
   * that could still fail, and must not fail the one running now.
   */
  track<T>(label: string, stack: string | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const poll: RunningPoll = { label, stack, controller: new AbortController(), promise: Promise.resolve(), abandoned: false };
    if (this.closed) this.cancel(poll);
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
    if (poll.abandoned) promise.catch(() => undefined);
    else this.running.add(poll);
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
    this.closed = true;
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

/** Which scope the polls of one async lineage go to; a fixture's lineage moves to its teardown's scope. */
interface PollOwner {
  scope: PollScope | undefined;
}

/** The runner's async context, shared through `globalThis` so a test module's copy of `expect` reads it. */
interface PollScopes {
  current(): PollScope | undefined;
}

const storage = new AsyncLocalStorage<PollOwner>();
const scopes: PollScopes = { current: () => storage.getStore()?.scope };
const slot = realmSlot<PollScopes>(pollScopesBrand);

/** Runs `run` in the lineage `owner` names, publishing the runner's context for a test module's `expect`. */
function enter<T>(owner: PollOwner, run: () => T): T {
  if (slot.get(globalThis) !== scopes) slot.set(globalThis, scopes);
  return storage.run(owner, run);
}

/**
 * Runs `run` with `scope` owning every poll it starts, however deep in its
 * async work and however long that work outlives the phase: a poll belongs
 * to the phase that started it, never to the one running when it is called.
 */
export function runInPollScope<T>(scope: PollScope, run: () => T): T {
  return enter({ scope }, run);
}

/** One lineage of async work whose polls go to the scope current where it started, until `handOver`. */
export interface PollLineage {
  run<T>(run: () => T): T;
  /** Sends the lineage's polls from now on to the scope current at this call. */
  handOver(): void;
}

/**
 * A lineage for work that spans two phases, a fixture: its setup runs in the
 * body's phase, and the rest of its function after `use` is its teardown's.
 */
export function pollLineage(): PollLineage {
  const owner: PollOwner = { scope: scopes.current() };
  return {
    run: (run) => enter(owner, run),
    handOver: () => {
      owner.scope = scopes.current();
    },
  };
}

/** The scope a poll started here belongs to, or undefined outside any phase (a standalone script). */
export function currentPollScope(): PollScope | undefined {
  return slot.get(globalThis)?.current();
}

/** The fixtures a test's `test.extend()` chain adds to one attempt. */

import type { FixtureDefinition } from '../collect/registry.ts';
import { pollLineage, type PollLineage } from '../expect/poll-scope.ts';
import { ConfigurationError } from '../internal/errors.ts';

/** One set-up fixture's teardown: the rest of its function after `use`. */
export interface FixtureTeardown {
  readonly name: string;
  run(): Promise<void>;
}

export interface ExtendedFixtures {
  /**
   * Runs every definition's setup in order, defining each value on the
   * fixtures object before the next definition, the hooks, or the body can
   * read it. Rejects with the first setup failure; the fixtures set up before
   * it still get torn down.
   */
  setUp(): Promise<void>;
  /**
   * The teardowns of the fixtures whose setup completed, last set up first.
   * Each releases its `use` and waits for the function to finish. Taking them
   * ends setup, as does the attempt's abort signal: a definition still running
   * that reaches `use` afterwards gets no attempt to hand its value to, so
   * `use` resolves at once and its teardown runs detached.
   */
  teardowns(): readonly FixtureTeardown[];
}

interface FixtureState {
  readonly name: string;
  /** The definition's whole run: pending while `use` is, settled once it returned. */
  readonly run: Promise<void>;
  release(): void;
  /** Where the function's polls go; handed to the teardown's scope when it is released. */
  readonly polls: PollLineage;
  /** A protocol violation (`use` called twice) to report at teardown. */
  misuse(): ConfigurationError | undefined;
}

/**
 * Binds a chain of fixture definitions to one attempt's fixture object. The
 * values land on the object as own read-only properties, so the unknown
 * fixture gate keeps seeing them as known and the base accessors stay lazy.
 * A name the engine already contributes fails the setup: the engine's
 * fixture is the one the body would otherwise read.
 */
export function createExtendedFixtures(
  definitions: readonly FixtureDefinition[],
  fixtures: object,
  engineName: string,
  signal?: AbortSignal,
): ExtendedFixtures {
  const active: FixtureState[] = [];
  let abandoned = signal?.aborted === true;
  const abandon = (): void => { abandoned = true; };
  if (!abandoned) signal?.addEventListener('abort', abandon, { once: true });

  /** Stops setup once its attempt has given up on it. */
  const requireActive = (): void => {
    if (abandoned) {
      throw new ConfigurationError('TEST_SETUP_FAILED', 'fixture setup ended after the attempt was abandoned');
    }
  };

  const setUpOne = async (definition: FixtureDefinition): Promise<void> => {
    const { name } = definition;
    // Own properties only: the base object is a plain object, so `in` would
    // also see `toString` and the rest of the prototype.
    if (Object.hasOwn(fixtures, name)) {
      throw new ConfigurationError(
        'TEST_SETUP_FAILED',
        `fixture "${name}" is contributed by engine ${engineName}; test.extend() cannot redefine it`,
      );
    }
    let ready!: () => void;
    let failed!: (cause: unknown) => void;
    const provided = new Promise<void>((resolve, reject) => {
      ready = resolve;
      failed = reject;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let used = false;
    let misuse: ConfigurationError | undefined;
    const use = (value: unknown): Promise<void> => {
      if (used) {
        misuse = new ConfigurationError(
          'TEST_SETUP_FAILED',
          `fixture "${name}" called use() twice; a fixture hands the test one value per attempt`,
        );
        const rejected = Promise.reject(misuse);
        // The violation is reported at teardown whether or not the fixture awaits this.
        rejected.catch(() => undefined);
        return rejected;
      }
      used = true;
      if (abandoned) {
        // The attempt gave up on this setup (it timed out) and has moved on
        // to teardown without it; the value has no test to go to, and holding
        // the definition here would keep whatever it allocated alive forever.
        release();
        ready();
        return released;
      }
      Object.defineProperty(fixtures, name, { value, enumerable: true });
      active.push({ name, run, release, polls, misuse: () => misuse });
      ready();
      return released;
    };
    // The function's polls are the body's until `use` returns, then its teardown's.
    const polls = pollLineage();
    const run = Promise.resolve()
      .then(() => polls.run(() => definition.fn(fixtures, use)))
      .then(
        () => {
          if (!used) {
            failed(
              new ConfigurationError(
                'TEST_SETUP_FAILED',
                `fixture "${name}" returned without calling use(); a fixture awaits use(value) to hand its value to the test`,
              ),
            );
          }
        },
        (cause: unknown) => {
          failed(cause);
          throw cause;
        },
      );
    // A fixture whose setup failed is never torn down, and one released after
    // the attempt abandoned it runs detached, so nothing else would observe
    // its rejection; a torn-down one is awaited below.
    run.catch(() => undefined);
    await provided;
  };

  return {
    async setUp(): Promise<void> {
      requireActive();
      for (const definition of definitions) {
        await setUpOne(definition);
        requireActive();
      }
    },
    teardowns(): readonly FixtureTeardown[] {
      abandon();
      signal?.removeEventListener('abort', abandon);
      return active.toReversed().map((state) => ({
        name: state.name,
        run: async () => {
          state.polls.handOver();
          state.release();
          await state.run;
          const misuse = state.misuse();
          if (misuse !== undefined) throw misuse;
        },
      }));
    },
  };
}

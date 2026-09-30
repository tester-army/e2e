/** The fixtures a test's `test.extend()` chain adds to one attempt. */

import type { FixtureDefinition } from '../collect/registry.ts';
import { ConfigurationError } from '../internal/errors.ts';
import { RUNNER_FIXTURE_NAMES } from '../internal/fixture-names.ts';

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
   * ends setup: a definition still running (the attempt timed out under it)
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
): ExtendedFixtures {
  const active: FixtureState[] = [];
  let abandoned = false;

  const setUpOne = async (definition: FixtureDefinition): Promise<void> => {
    const { name } = definition;
    // Own properties only: the base object is a plain object, so `in` would
    // also see `toString` and the rest of the prototype.
    if (Object.hasOwn(fixtures, name)) {
      const owner = RUNNER_FIXTURE_NAMES.has(name) ? 'the runner (a built-in fixture)' : `engine ${engineName}`;
      throw new ConfigurationError(
        'TEST_SETUP_FAILED',
        `fixture "${name}" is contributed by ${owner}; test.extend() cannot redefine it`,
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
      ready();
      return released;
    };
    const run = Promise.resolve()
      .then(() => definition.fn(fixtures, use))
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
    if (!abandoned) active.push({ name, run, release, misuse: () => misuse });
  };

  return {
    async setUp(): Promise<void> {
      for (const definition of definitions) await setUpOne(definition);
    },
    teardowns(): readonly FixtureTeardown[] {
      abandoned = true;
      return active.toReversed().map((state) => ({
        name: state.name,
        run: async () => {
          state.release();
          await state.run;
          const misuse = state.misuse();
          if (misuse !== undefined) throw misuse;
        },
      }));
    },
  };
}

/**
 * Registers CIGE cases as e2e tests. One case is one test: its title is the
 * Intent statement, its tags are `cige` and `cige:<id>` (so `--tag
 * cige:<id>` replays exactly one case), its `agentContext` is the case's
 * Context, and its agent is the one Context names. Call it from an ordinary
 * `*.e2e.ts` file; it runs while the file evaluates, so a broken case or a
 * hook the code does not define fails collection, before any test runs.
 */

import { test as baseTest, type TestAPI, type TestFixtures, type TestOptions } from 'e2e';

import { loadCigeCases, type CigeRoot } from './load.ts';
import { renderAgentContext } from './render.ts';
import { missingHooks, runCige, type CigeHooks } from './run.ts';
import { CigeValidationError, type CigeCase } from './schema.ts';

/** The tag every CIGE test carries. */
export const CIGE_TAG = 'cige';

/** The tag that selects one case by its id. */
export function cigeTag(id: string): string {
  return `${CIGE_TAG}:${id}`;
}

export interface CigeSuiteOptions<Fixtures = TestFixtures> {
  /** The `test` to register through, such as one from `test.extend()`; default the `test` from `e2e`. */
  readonly test?: TestAPI<Fixtures>;
  /** Directory the globs resolve against, a path or `new URL('.', import.meta.url)`; default the working directory. */
  readonly root?: CigeRoot;
  /** The hooks the cases' preconditions and evidence name. */
  readonly hooks?: CigeHooks<Fixtures>;
  /** Test options every case gets, such as `timeout`, `retries`, or more `tags`. */
  readonly options?: Omit<TestOptions, 'agentContext' | 'only'>;
}

/**
 * Registers one test per case. `cases` is a glob or globs of `.cige.json`
 * files, or cases already loaded. Returns the cases it registered.
 */
export function cigeSuite<Fixtures extends TestFixtures = TestFixtures>(
  cases: string | readonly string[] | readonly CigeCase[],
  suiteOptions: CigeSuiteOptions<Fixtures> = {},
): readonly CigeCase[] {
  const loaded =
    typeof cases === 'string' || cases.every((entry) => typeof entry === 'string')
      ? loadCigeCases(cases as string | readonly string[], suiteOptions.root === undefined ? {} : { root: suiteOptions.root })
      : (cases as readonly CigeCase[]);
  const register = (suiteOptions.test ?? baseTest) as TestAPI<Fixtures>;
  const hooks = suiteOptions.hooks ?? {};
  for (const testCase of loaded) {
    const missing = missingHooks(testCase, hooks);
    if (missing.length > 0) {
      throw new CigeValidationError(testCase.file ?? testCase.id, missing.map((name) => `hook "${name}" is named by the case but not passed in hooks`));
    }
    const agentContext = renderAgentContext(testCase);
    const extra = suiteOptions.options ?? {};
    const options: TestOptions = {
      ...extra,
      tags: [...new Set([CIGE_TAG, cigeTag(testCase.id), ...(extra.tags ?? [])])],
      ...(agentContext === undefined ? {} : { agentContext }),
      ...(testCase.context.agent === undefined ? {} : { agent: testCase.context.agent }),
    };
    register(testCase.intent.statement, options, (fixtures) => runCige(testCase, fixtures, { hooks }));
  }
  return loaded;
}

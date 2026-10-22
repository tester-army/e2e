/**
 * Registers CIGE cases as e2e tests. One case is one test, or one per
 * variant: its title is the Intent statement, its tags are `cige` and
 * `cige:<id>` (so `--tag cige:<id>` replays exactly one case) plus
 * `cige:<id>/<variant>` for a variant, its `agentContext` is the case's
 * Context, and its agent, platforms, capabilities, and session are the ones
 * Context or the variant names. Call it from an ordinary `*.e2e.ts` file; it
 * runs while the file evaluates, so a broken case or a hook the code does not
 * define fails collection, before any test runs.
 */

import { test as baseTest, type TestAPI, type TestFixtures, type TestOptions } from 'e2e';

import { DEFAULT_CASES, type CigeConfig } from './config.ts';
import { checkCases, loadCigeCases, type CigeRoot } from './load.ts';
import { pluginProblems } from './plugins.ts';
import { agentContextProblem, renderAgentContext } from './render.ts';
import { missingHooks, missingStepKinds, runCige, type CigeHooks } from './run.ts';
import { CigeValidationError, type CigeCase } from './schema.ts';
import { expandVariants } from './variants.ts';

/** The tag every CIGE test carries. */
export const CIGE_TAG = 'cige';

/** The tag that selects one case by its id, or one of its variants. */
export function cigeTag(id: string, variant?: string): string {
  return variant === undefined ? `${CIGE_TAG}:${id}` : `${CIGE_TAG}:${id}/${variant}`;
}

export interface CigeSuiteOptions<Fixtures = TestFixtures> {
  /** The `test` to register through, such as one from `test.extend()`; default the `test` from `e2e`. */
  readonly test?: TestAPI<Fixtures>;
  /** Directory the globs resolve against, a path or `new URL('.', import.meta.url)`; default the working directory. */
  readonly root?: CigeRoot;
  /** The hooks the cases' preconditions and evidence name. */
  readonly hooks?: CigeHooks<Fixtures>;
  /** The environments of the CIGE config; once set, every case's `Context.environment` must name one. */
  readonly environments?: CigeConfig<Fixtures>['environments'];
  /** The CIGE config's plugins. */
  readonly plugins?: CigeConfig<Fixtures>['plugins'];
  /** Test options every case gets, such as `timeout`, `retries`, or more `tags`. A case's own Context wins. */
  readonly options?: Omit<TestOptions, 'agentContext' | 'only'>;
}

function isGlobs(cases: string | readonly string[] | readonly CigeCase[]): cases is string | readonly string[] {
  return typeof cases === 'string' || cases.every((entry) => typeof entry === 'string');
}

function isConfig<Fixtures>(cases: unknown): cases is CigeConfig<Fixtures> {
  return typeof cases === 'object' && cases !== null && !Array.isArray(cases);
}

/** The test options a resolved case runs with: the suite's, then the case's Context, which wins. */
function optionsFor(testCase: CigeCase, extra: Omit<TestOptions, 'agentContext' | 'only'>, agentContext: string | undefined): TestOptions {
  const { context } = testCase;
  const tags = [CIGE_TAG, cigeTag(testCase.id), ...(testCase.variant === undefined ? [] : [cigeTag(testCase.id, testCase.variant)]), ...(extra.tags ?? [])];
  return {
    ...extra,
    tags: [...new Set(tags)],
    ...(agentContext === undefined ? {} : { agentContext }),
    ...(context.agent === undefined ? {} : { agent: context.agent }),
    ...(context.platforms === undefined ? {} : { platforms: context.platforms }),
    ...(context.requires === undefined ? {} : { requires: context.requires }),
    ...(context.session === undefined ? {} : { session: context.session }),
  };
}

/**
 * Registers one test per case and variant. `cases` is a glob or globs of
 * `.cige.json` files, cases already loaded, or the CIGE config (whose
 * `cases`, `root`, `hooks`, and `environments` it reads). Returns the cases
 * it registered, before variants are resolved.
 */
export function cigeSuite<Fixtures extends TestFixtures = TestFixtures>(
  cases: string | readonly string[] | readonly CigeCase[] | CigeConfig<Fixtures>,
  suiteOptions: CigeSuiteOptions<Fixtures> = {},
): readonly CigeCase[] {
  if (Array.isArray(cases) && cases.length === 0) {
    // Without this, an empty list would pass for globs and report "matches no file".
    throw new CigeValidationError('cigeSuite', ['was given no cases; pass globs, loaded cases, or the CIGE config']);
  }
  if (isConfig<Fixtures>(cases)) {
    const { cases: globs, root, hooks, environments, plugins } = cases;
    return cigeSuite(globs ?? DEFAULT_CASES, {
      ...suiteOptions,
      ...(root === undefined ? {} : { root }),
      ...(hooks === undefined ? {} : { hooks }),
      ...(environments === undefined ? {} : { environments }),
      ...(plugins === undefined ? {} : { plugins }),
    });
  }
  const globs = isGlobs(cases);
  const loaded = globs ? loadCigeCases(cases, suiteOptions.root === undefined ? {} : { root: suiteOptions.root }) : cases;
  if (globs && loaded.length === 0) {
    // A mistyped glob must not turn a suite green by registering nothing.
    throw new CigeValidationError(JSON.stringify(cases), ['matches no file; check the glob and root']);
  }
  if (!globs) checkCases(loaded);
  const titles = new Map<string, string>();
  for (const testCase of loaded) {
    const other = titles.get(testCase.intent.statement);
    if (other !== undefined) {
      throw new CigeValidationError(testCase.file ?? testCase.id, [
        `Intent "${testCase.intent.statement}" is also the Intent of "${other}"; one Intent is one test, so merge the cases, reword one, or make them Variants of one case`,
      ]);
    }
    titles.set(testCase.intent.statement, testCase.id);
  }
  const register = (suiteOptions.test ?? baseTest) as TestAPI<Fixtures>;
  const hooks = suiteOptions.hooks ?? {};
  const plugins = suiteOptions.plugins ?? [];
  const { environments } = suiteOptions;
  const invalidPlugins = pluginProblems(plugins);
  if (invalidPlugins.length > 0) throw new CigeValidationError('the CIGE config', invalidPlugins);
  for (const testCase of loaded) {
    const problems = [
      ...missingHooks(testCase, hooks).map((name) => `hook "${name}" is named by the case but not passed in hooks`),
      ...missingStepKinds(testCase, plugins).map((kind) => `step kind "${kind}" is used by the case but no plugin registers it`),
    ];
    const environment = testCase.context.environment;
    if (environments !== undefined && environment !== undefined && !Object.hasOwn(environments, environment)) {
      problems.push(`Context.environment "${environment}" is not one of the config's environments (${Object.keys(environments).join(', ') || 'none'})`);
    }
    if (problems.length > 0) throw new CigeValidationError(testCase.file ?? testCase.id, problems);
    for (const resolved of expandVariants(testCase)) {
      const title = resolved.variant === undefined ? resolved.intent.statement : `${resolved.intent.statement} [${resolved.variant}]`;
      // Measured again here: plugins add context the loader never saw.
      const agentContext = renderAgentContext(resolved, plugins);
      const tooLarge = agentContextProblem(agentContext);
      if (tooLarge !== undefined) throw new CigeValidationError(testCase.file ?? testCase.id, [tooLarge]);
      register(title, optionsFor(resolved, suiteOptions.options ?? {}, agentContext), (fixtures) => runCige(resolved, fixtures, { hooks, plugins }));
    }
  }
  return loaded;
}

/**
 * The CIGE config: one module the suite, the reporter, and the `e2e-cige`
 * command all read, so the cases, their hooks, the environments a repair
 * replays in, and the resolvers that fetch a spec or release notes are
 * declared once. Keep it in `cige.config.ts` at the project root; the
 * command loads it from there.
 */

import type { TestFixtures } from 'e2e';

import type { CigeRoot } from './load.ts';
import type { CigePlugin } from './plugins.ts';
import type { CigeHooks } from './run.ts';
import type { CigeCase } from './schema.ts';

/** The cases a config selects when it names none. */
export const DEFAULT_CASES = 'tests/**/*.cige.json';

/** An environment action: plain code with no fixtures, so it runs outside a test. */
export type CigeEnvironmentAction = () => unknown;

/**
 * An environment a case runs and replays in, keyed by the case's
 * `Context.environment`. `config` is the e2e config file whose targets
 * reach it. The actions let a recovering agent restore it without editing
 * the case: `provision` creates it, `reset` returns it to the state the
 * cases start from (re-seed, re-authenticate), `teardown` removes it.
 */
export interface CigeEnvironment {
  readonly config?: string;
  readonly provision?: CigeEnvironmentAction;
  readonly reset?: CigeEnvironmentAction;
  readonly teardown?: CigeEnvironmentAction;
}

/** What a ref resolver is asked about: one case, the build under test, and its environment. */
export interface CigeRefContext {
  readonly testCase: CigeCase;
  readonly build: string | undefined;
  readonly environment: string | undefined;
  /** The case's pointer for this ref, with `{build}` and `{environment}` filled in, when it sets one. */
  readonly pointer: string | undefined;
}

/**
 * What a ref resolver found: the text itself (release notes, a spec
 * section), a URL to read it at, or files such as the mocks a build is
 * expected to produce. Whatever it returns is written for an agent to
 * read, so it must never carry a secret.
 */
export interface CigeRef {
  readonly text?: string;
  readonly url?: string;
  readonly files?: readonly string[];
}

export type CigeRefResolver = (context: CigeRefContext) => CigeRef | undefined | Promise<CigeRef | undefined>;

/**
 * Resolvers for the ground truth a classifier compares a failure with:
 * `spec` the expected behavior, `build` what the build under test shipped
 * (release notes, a changelog), `expected` what it should produce (mocks,
 * fixtures). They run only on request (`e2e-cige refs <id>`), never during
 * a run.
 */
export interface CigeRefs {
  readonly spec?: CigeRefResolver;
  readonly build?: CigeRefResolver;
  readonly expected?: CigeRefResolver;
}

export interface CigeConfig<Fixtures = TestFixtures> {
  /** Globs of the `.cige.json` files; default every `*.cige.json` under `tests/`. */
  readonly cases?: string | readonly string[];
  /**
   * Directory the globs resolve against. Unset, each reader uses its own:
   * `cigeSuite` the working directory, the reporter the project root, and
   * `e2e-cige` the config file's directory. Set it to
   * `new URL('.', import.meta.url)` so all three agree.
   */
  readonly root?: CigeRoot;
  /** The hooks the cases' preconditions and evidence name. They run inside a test, with its fixtures. */
  readonly hooks?: CigeHooks<Fixtures>;
  /** Environments by name. Once set, every case's `Context.environment` must name one. */
  readonly environments?: Readonly<Record<string, CigeEnvironment>>;
  /** Resolvers for a case's spec, release notes, and expected output. */
  readonly refs?: CigeRefs;
  /** Your own behavior: context lines, guardrail checks, classification, summary fields, readiness gaps, and step kinds. */
  readonly plugins?: readonly CigePlugin<Fixtures>[];
  /** The e2e config the cases run under, when it isn't the nearest `e2e.config.ts`; a replay passes it as `--config` unless the case's environment names its own. */
  readonly e2eConfig?: string;
  /** The build under test, such as a version or a commit: the summaries' `build`, and `{build}` in a ref. */
  readonly build?: string | undefined;
  /** The directory run summaries go to; default `cige` beside `report.json`. */
  readonly outputDir?: string;
}

/** Declares the CIGE config, typed. Export it as the default of `cige.config.ts`. */
export function defineCige<Fixtures extends TestFixtures = TestFixtures>(config: CigeConfig<Fixtures>): CigeConfig<Fixtures> {
  return config;
}

/** The case's ref pointer with `{build}` and `{environment}` filled in; a placeholder with no value stays as written. */
export function fillRef(pointer: string | undefined, values: { readonly build?: string | undefined; readonly environment?: string | undefined }): string | undefined {
  if (pointer === undefined) return undefined;
  return pointer.replace(/\{(build|environment)\}/g, (whole, name: 'build' | 'environment') => values[name] ?? whole);
}

/** Creates throwaway fixture projects and runs them through the built runner. */

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { web } from '@e2e-dev/web';
import type { ListOptions, ListedPair, RunOptions, RunOutcome } from '../../src/run/runner.ts';
import type { E2EConfig } from '../../src/index.ts';
import { createFakeEngine, FAKE_APP } from './fake-engine.ts';

export type { RunOptions, RunOutcome };

// The built runner is used so fixture test files resolving the "e2e"
// self-reference share the same registry instance. The specifier is kept
// non-literal so typechecking does not require a prior build.
const builtRunnerModule = '../../dist/run/runner.js';
const { list, run } = (await import(builtRunnerModule)) as typeof import('../../src/run/runner.ts');

const PACKAGE_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const TMP_ROOT = path.join(PACKAGE_ROOT, 'tests', 'tmp-projects');

type Target = NonNullable<E2EConfig['targets']>[number];

/**
 * One web target on the fixture app at `url`. The handle comes from the built
 * web package, whose `e2e` peer resolves to this package's dist, so the brand
 * symbol is shared at runtime even though the src/dist types differ; this is
 * the one place that difference is cast away.
 */
export function webTarget(name: string, url: string): Target {
  return { name, engine: web() as unknown as NonNullable<Target['engine']>, app: { url } };
}

/**
 * The target a suite runs against unless its config names its own: the web
 * target on the fixture app at `appUrl`, or, for a suite that opens no page
 * and so passes none, a fake engine that starts no browser.
 */
function defaultTargets(appUrl: string | undefined): NonNullable<E2EConfig['targets']> {
  if (appUrl === undefined) return [{ name: 'fake', platform: 'fake', engine: createFakeEngine({ state: true }).engine, app: FAKE_APP }];
  return [webTarget('web', appUrl)];
}

/** The run environment: the caller's, outside CI, with `APP_URL` the fixture app's URL or unset, never the caller's. */
function fixtureEnv(appUrl: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: '' };
  delete env['APP_URL'];
  return appUrl === undefined ? env : { ...env, APP_URL: appUrl };
}

export interface FixtureProject {
  readonly dir: string;
  cleanup(): void;
}

/** Writes fixture test files into a fresh project directory inside the package. */
export function createProject(files: Readonly<Record<string, string>>): FixtureProject {
  const dir = path.join(TMP_ROOT, `p-${randomBytes(6).toString('hex')}`);
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(dir, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  }
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Every regular file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    return statSync(file).isDirectory() ? filesUnder(file) : [file];
  });
}

/** The bytes of every file under `dir` as latin1 text keyed by path. */
export function contentsUnder(dir: string): [string, string][] {
  return filesUnder(dir).map((file) => [file, readFileSync(file).toString('latin1')]);
}

export interface RunProjectOptions {
  /** The fixture app; without one, the default target is a fake engine and no browser starts. */
  appUrl?: string;
  /** Overrides of the fixture config; `targets` defaults to the web target on `appUrl`, or the fake engine without one. */
  config?: Partial<E2EConfig>;
  runOptions?: Partial<RunOptions>;
}

/** Runs a fixture project and returns the outcome. */
export async function runProject(
  files: Readonly<Record<string, string>>,
  options: RunProjectOptions,
): Promise<{ outcome: RunOutcome; project: FixtureProject }> {
  const project = createProject(files);
  return { outcome: await runExisting(project, options), project };
}

/**
 * Runs an existing project directory. Repeated runs share on-disk state, which
 * is what cache tests need: the second run must see what the first wrote.
 */
export async function runExisting(
  project: FixtureProject,
  options: RunProjectOptions,
): Promise<RunOutcome> {
  return run({
    cwd: project.dir,
    // Core knows no engine: a web target is served by the playwright engine
    // the test explicitly passes, exactly as a project config would.
    rawConfig: { targets: defaultTargets(options.appUrl), ...options.config },
    env: fixtureEnv(options.appUrl),
    quiet: true,
    ...options.runOptions,
  });
}

/** Lists a fixture project's selection without running it; the project is left for the caller to clean up. */
export async function listProject(
  files: Readonly<Record<string, string>>,
  options: RunProjectOptions & { listOptions?: Partial<ListOptions> },
): Promise<{ pairs: ListedPair[]; project: FixtureProject }> {
  const project = createProject(files);
  const { pairs } = await list({
    cwd: project.dir,
    rawConfig: { targets: defaultTargets(options.appUrl), ...options.config },
    env: fixtureEnv(options.appUrl),
    ...options.listOptions,
  });
  return { pairs, project };
}

/** Default file-backed config used by worker-path integration tests that open the fixture app. */
export function workerConfigSource(workers: number, extra = ''): string {
  return `import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

export default {
  targets: [{ name: 'web', engine: web(), app: { url: process.env.APP_URL! } }],
  workers: ${workers},${extra}
} satisfies E2EConfig;
`;
}

/**
 * A file-backed worker-path config on the fake engine, for suites that open
 * no page: each worker imports the helper and builds its own instance.
 */
export function workerFakeConfigSource(workers: number, extra = ''): string {
  return `import type { E2EConfig } from 'e2e';
import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';

export default {
  targets: [{ name: 'fake', platform: 'fake', engine: createFakeEngine({ state: true }).engine, app: FAKE_APP }],
  workers: ${workers},${extra}
} satisfies E2EConfig;
`;
}

/**
 * Runs a fixture project through the parallel worker path: the config is a
 * real file, so the runner schedules units across worker processes.
 */
export async function runProjectWithConfigFile(
  files: Readonly<Record<string, string>>,
  options: RunProjectOptions & { configSource: string },
): Promise<{ outcome: RunOutcome; project: FixtureProject }> {
  const project = createProject({ ...files, 'e2e.config.ts': options.configSource });
  return { outcome: await runExistingWithConfigFile(project, options), project };
}

/**
 * Runs an existing project through its own `e2e.config.ts` on the worker
 * path. Repeated runs share on-disk state, as with `runExisting`.
 */
export async function runExistingWithConfigFile(
  project: FixtureProject,
  options: Omit<RunProjectOptions, 'config'>,
): Promise<RunOutcome> {
  const previousAppUrl = process.env['APP_URL'];
  if (options.appUrl !== undefined) process.env['APP_URL'] = options.appUrl;
  try {
    return await run({
      cwd: project.dir,
      env: fixtureEnv(options.appUrl),
      quiet: true,
      ...options.runOptions,
    });
  } finally {
    if (previousAppUrl === undefined) delete process.env['APP_URL'];
    else process.env['APP_URL'] = previousAppUrl;
  }
}

/**
 * Finds one result by test title, and by repeat under `--repeat-each`. A miss
 * names the titles the run did produce and its run-level errors, since an
 * empty run usually means collection failed (a fixture importing a package
 * that no longer exists, a config the resolver refused) and the error says
 * which.
 */
export function resultByTitle(outcome: RunOutcome, title: string, repeat = 0) {
  const result = outcome.results.find((candidate) => candidate.test.title === title && candidate.repeat === repeat);
  if (result === undefined) {
    throw new Error(
      `no result titled "${title}" (repeat ${String(repeat)}); got: ${outcome.results.map((r) => `${r.test.title}#${String(r.repeat)}`).join(', ')}; run errors: ${JSON.stringify(outcome.report.run.errors)}`,
    );
  }
  return result;
}

/** Creates throwaway fixture projects and runs them through the built runner. */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { playwright } from '@e2edev/playwright';
import type { ListOptions, ListedPair, RunOptions, RunOutcome } from '../../src/run/runner.ts';
import type { E2EConfig } from '../../src/index.ts';

export type { RunOptions, RunOutcome };

// The built runner is used so fixture test files resolving the "@e2edev/e2e"
// self-reference share the same registry instance. The specifier is kept
// non-literal so typechecking does not require a prior build.
const builtRunnerModule = '../../dist/run/runner.js';
const { list, run } = (await import(builtRunnerModule)) as typeof import('../../src/run/runner.ts');

const PACKAGE_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const TMP_ROOT = path.join(PACKAGE_ROOT, 'tests', 'tmp-projects');

/**
 * The web target integration suites run against, its engine declaring the
 * fixture app's URL. The handle comes from the built playwright package, whose
 * `e2e` peer resolves to this package's dist, so the brand symbol is shared at
 * runtime even though the src/dist types differ.
 */
function defaultTargets(appUrl: string): NonNullable<E2EConfig['targets']> {
  return [{ name: 'web', engine: playwright({ url: appUrl }) }] as unknown as NonNullable<
    E2EConfig['targets']
  >;
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

export interface RunProjectOptions {
  appUrl: string;
  config?: E2EConfig;
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
    env: {
      ...process.env,
      APP_URL: options.appUrl,
      CI: '',
    },
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
    env: { ...process.env, APP_URL: options.appUrl, CI: '' },
    ...options.listOptions,
  });
  return { pairs, project };
}

/** Default file-backed config used by worker-path integration tests. */
export function workerConfigSource(workers: number, extra = ''): string {
  return `import type { E2EConfig } from '@e2edev/e2e';
import { playwright } from '@e2edev/playwright';

export default {
  targets: [{ name: 'web', engine: playwright({ url: process.env.APP_URL! }) }],
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
  const previousAppUrl = process.env['APP_URL'];
  process.env['APP_URL'] = options.appUrl;
  try {
    const outcome = await run({
      cwd: project.dir,
      env: { ...process.env, APP_URL: options.appUrl, CI: '' },
      quiet: true,
      ...options.runOptions,
    });
    return { outcome, project };
  } finally {
    if (previousAppUrl === undefined) delete process.env['APP_URL'];
    else process.env['APP_URL'] = previousAppUrl;
  }
}

/** Finds one result by test title suffix. */
export function resultByTitle(outcome: RunOutcome, title: string) {
  const result = outcome.results.find((candidate) => candidate.test.title === title);
  if (result === undefined) {
    throw new Error(
      `no result titled "${title}"; got: ${outcome.results.map((r) => r.test.title).join(', ')}`,
    );
  }
  return result;
}

/** Creates throwaway fixture projects and runs them through the built runner. */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The built runner is used so fixture test files resolving the "e2e"
// self-reference share the same registry instance.
import { run, type RunOptions, type RunOutcome } from '../../dist/run/runner.js';
import type { E2EConfig } from '../../dist/index.js';

const PACKAGE_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const TMP_ROOT = path.join(PACKAGE_ROOT, 'tests', 'tmp-projects');

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
  config?: Partial<E2EConfig>;
  runOptions?: Partial<RunOptions>;
}

/** Runs a fixture project and returns the outcome. */
export async function runProject(
  files: Readonly<Record<string, string>>,
  options: RunProjectOptions,
): Promise<{ outcome: RunOutcome; project: FixtureProject }> {
  const project = createProject(files);
  const outcome = await run({
    cwd: project.dir,
    rawConfig: { ...options.config } as E2EConfig,
    env: {
      ...process.env,
      APP_URL: options.appUrl,
      CI: '',
    } as NodeJS.ProcessEnv,
    quiet: true,
    ...options.runOptions,
  });
  return { outcome, project };
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

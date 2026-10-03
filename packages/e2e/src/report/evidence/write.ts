/**
 * Puts a planned pack on disk as a live `.evidence` directory. YAML files are
 * written as JSON, which is YAML. Every copied file is an artifact the report
 * names, resolved under the artifacts root and refused outside it; one that is
 * gone (a deleted recording) is left out together with every reference to it,
 * so the pack never names a file it does not hold.
 */

import { constants } from 'node:fs';
import { access, copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LogPlan, PackPlan, StepPlan, TestPlan } from './map.ts';

export interface PackRoots {
  readonly artifactsRoot: string;
}

/** Writes `plan` into `packDir`, which must not exist yet or be empty; stops between tests once `signal` aborts. */
export async function writePack(plan: PackPlan, packDir: string, roots: PackRoots, signal?: AbortSignal): Promise<void> {
  await mkdir(path.join(packDir, 'tests'), { recursive: true });
  await writeJson(path.join(packDir, 'run.yaml'), plan.run);
  // The global coverage directory must exist in a sealed pack; a file keeps the zip from dropping it.
  await writeJson(path.join(packDir, 'coverage', 'e2e-summary.json'), plan.coverage);
  for (const test of plan.tests) {
    signal?.throwIfAborted();
    await writeTest(test, path.join(packDir, 'tests', test.dir), roots);
  }
}

/** One test folder: definition, steps, logs and their meta, then `result.yaml`. */
async function writeTest(test: TestPlan, dir: string, roots: PackRoots): Promise<void> {
  await mkdir(path.join(dir, 'steps'), { recursive: true });
  await writeFile(path.join(dir, test.definition.name), test.definition.content);
  if (test.steps.length === 0) await writeFile(path.join(dir, 'steps', '.keep'), '');
  for (const step of test.steps) await writeStep(step, path.join(dir, 'steps', step.folder), roots);

  const logs: { name: string; file: string; format: string }[] = [];
  for (const log of test.logs) {
    if (await writeLog(log, path.join(dir, 'logs'), roots)) logs.push({ name: log.name, file: log.file, format: log.format });
  }
  await writeJson(path.join(dir, 'logs', 'meta.yaml'), { logs });
  await writeJson(path.join(dir, 'result.yaml'), test.result);
}

/** One step folder; a failure record drops each page-state reference whose file was not copied. */
async function writeStep(step: StepPlan, dir: string, roots: PackRoots): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeJson(path.join(dir, 'step.json'), step.record);
  const shot = step.screenshot === undefined
    ? false
    : await copyInside(roots.artifactsRoot, step.screenshot, path.join(dir, `screenshot${path.extname(step.screenshot)}`));
  const screen = step.screen === undefined ? false : await copyInside(roots.artifactsRoot, step.screen, path.join(dir, 'screen.txt'));
  if (step.failure === undefined) return;
  const pageState = { ...(step.failure['page_state'] as Record<string, unknown> | undefined) };
  if (!shot) delete pageState['screenshot'];
  if (!screen) delete pageState['a11y'];
  const failure = Object.keys(pageState).length === 0 ? withoutKey(step.failure, 'page_state') : { ...step.failure, page_state: pageState };
  await writeJson(path.join(dir, 'failure.yaml'), failure);
}

/** One log file, copied or written; false when its source could not be copied. */
async function writeLog(log: LogPlan, dir: string, roots: PackRoots): Promise<boolean> {
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, log.file);
  if (log.source !== undefined) return copyInside(roots.artifactsRoot, log.source, target);
  await writeFile(target, log.content ?? '');
  return true;
}

/** Copies `relative` from under `root` to `target`; false when it resolves outside `root` or cannot be read, and throws when writing fails. */
async function copyInside(root: string, relative: string, target: string): Promise<boolean> {
  const source = path.resolve(root, relative);
  const fromRoot = path.relative(root, source);
  if (fromRoot === '' || fromRoot.startsWith('..') || path.isAbsolute(fromRoot)) return false;
  try {
    await access(source, constants.R_OK);
  } catch {
    // A source that is gone or unreadable is left out; a failure writing into the pack is not.
    return false;
  }
  await copyFile(source, target);
  return true;
}

/** Writes `value` as indented JSON, which is also YAML. */
async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** `record` without `key`. */
function withoutKey(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _dropped, ...rest } = record;
  return rest;
}

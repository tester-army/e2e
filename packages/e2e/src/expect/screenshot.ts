/**
 * `toHaveScreenshot`: the screen, or one locator's box on it, compared
 * against a PNG stored beside the test file. Pixels come from the engine's
 * observation, so every engine that captures pixels gets visual comparison
 * with nothing of its own to implement.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { LocatorExpression } from '../engine/surface.ts';
import { writeFileAtomic } from '../internal/atomic-write.ts';
import { ConfigurationError, TestError } from '../internal/errors.ts';
import { compareImages, decodePng, encodePng, type ImageComparison, type RgbaImage } from '../internal/image.ts';
import { pollCondition, type Deadline } from '../internal/time.ts';
import { describeExpression } from '../locator/expression.ts';
import type { ScreenContext } from '../locator/screen.ts';
import type { ScreenshotContext } from '../run/screenshots.ts';
import type { ScreenExpectation, ScreenshotOptions } from '../types.ts';
import { parseScreenshotCall, type ScreenshotCall } from './screenshot-call.ts';
import { screenshotCapturer, type Capture } from './screenshot-capture.ts';

/** The stored screenshot one call compares against: its absolute path, and project-relative as a failure names it. */
interface Stored {
  readonly file: string;
  readonly shown: string;
}

/** One call in one attempt. */
interface Run {
  readonly context: ScreenContext;
  readonly store: ScreenshotContext;
  readonly api: string;
  readonly call: ScreenshotCall;
  readonly stored: Stored;
  readonly capture: () => Promise<Capture>;
}

/** The `expect(screen)` surface; a scoped screen (a frame) refuses, since its box is not known. */
export function createScreenExpectation(context: ScreenContext, scoped: boolean, negated = false): ScreenExpectation {
  return {
    get not() {
      return createScreenExpectation(context, scoped, !negated);
    },
    toHaveScreenshot: (nameOrOptions?: string | ScreenshotOptions, options?: ScreenshotOptions) => {
      if (scoped) {
        return Promise.reject(new TestError(
          'INVALID_ARGUMENT',
          'toHaveScreenshot compares the whole screen or one locator; call it on screen, or on a locator inside the frame',
        ));
      }
      return expectScreenshot(context, undefined, negated, nameOrOptions, options);
    },
  };
}

/**
 * Runs one `toHaveScreenshot` call as an assertion step: of the whole screen
 * when `subject` is undefined, else of the one node it matches.
 */
export async function expectScreenshot(
  context: ScreenContext,
  subject: LocatorExpression | undefined,
  negated: boolean,
  nameOrOptions: string | ScreenshotOptions | undefined,
  maybeOptions: ScreenshotOptions | undefined,
): Promise<void> {
  const api = `expect.${negated ? 'not.' : ''}toHaveScreenshot`;
  const store = context.screenshots;
  if (store === undefined) {
    throw new TestError('UNSUPPORTED_CAPABILITY', `${api} keeps screenshots beside a test file, so it runs only inside a test`);
  }
  const call = parseScreenshotCall(api, store, nameOrOptions, maybeOptions);
  const file = path.join(store.directory, `${call.stem}${store.suffix}.png`);
  const stored: Stored = { file, shown: path.relative(store.projectRoot, file).split(path.sep).join('/') };
  const label = `${subject === undefined ? 'screen' : describeExpression(subject)} vs ${call.stem}.png`;
  await context.steps.run('assertion', api, label, async () => {
    if (store.withholdsPixels()) {
      throw new ConfigurationError('POLICY_DENIED', `${api} is denied after a secret fill because the app may display the secret outside a secure field`);
    }
    const deadline = context.engine.deadline(call.timeout ?? context.engine.assertionTimeout);
    const capture = screenshotCapturer(context, { api, subject, masks: call.masks, maskColor: call.maskColor }, deadline);
    const run: Run = { context, store, api, call, stored, capture };
    const expected = existsSync(file) ? readStored(api, stored) : undefined;
    if (expected !== undefined && (negated || !store.update) && store.written.has(file)) {
      throw failure(api, `${stored.shown} was written earlier in this run and is not reviewed yet: look at it, commit it, and run again`, stored, 'unreviewed stored screenshot');
    }
    if (negated) {
      await expectDifferent(run, expected, deadline);
      return;
    }
    const settled = await matchOrSettle(run, expected, deadline);
    if (settled !== undefined) await keep(run, expected, settled);
  }, { verifies: true });
}

/**
 * Captures until the screen matches the stored screenshot, or, with none
 * stored or `update` on, until it holds still: two captures in a row the same
 * within the call's tolerance. Returns the screen that held still, to keep;
 * undefined when it matched.
 */
async function matchOrSettle(run: Run, expected: RgbaImage | undefined, deadline: Deadline): Promise<RgbaImage | undefined> {
  const settles = expected === undefined || run.store.update;
  // The newest capture with pixels, and why the newest without had none: a
  // read the deadline cut short can come back empty, and must not hide what
  // the screen showed before it.
  let latest: { readonly image: RgbaImage; readonly comparison: ImageComparison | undefined } | undefined;
  let missing: string | undefined;
  let previous: RgbaImage | undefined;
  let unsettled: readonly [RgbaImage, RgbaImage] | undefined;
  let settled: RgbaImage | undefined;
  let captures = 0;
  await pollCondition({
    deadline,
    signal: run.context.engine.signal,
    negated: false,
    evaluate: async () => {
      const capture = await run.capture();
      if ('missing' in capture) {
        missing = capture.missing;
        return undefined;
      }
      captures += 1;
      const current = capture.image;
      const comparison = expected === undefined ? undefined : compareImages(expected, current, run.call.tolerance);
      latest = { image: current, comparison };
      if (comparison?.kind === 'match') return true;
      if (!settles) return false;
      const before = previous;
      previous = current;
      if (before === undefined) return false;
      if (compareImages(before, current, run.call.tolerance).kind === 'match') {
        settled = current;
        return true;
      }
      unsettled = [before, current];
      return false;
    },
    onTimeout: (cause) => {
      if (latest === undefined) return failure(run.api, missing ?? 'no screenshot was taken', run.stored, 'no screenshot', cause);
      if (!settles && expected !== undefined && latest.comparison !== undefined && latest.comparison.kind !== 'match') {
        return mismatch(run, expected, latest.image, latest.comparison, cause);
      }
      const images: string[] = [];
      if (unsettled !== undefined) {
        const between = compareImages(unsettled[0], unsettled[1], { threshold: 0, maxDiffPixels: undefined, maxDiffPixelRatio: undefined });
        if (between.kind === 'pixels') images.push(`diff: ${attach(run, `${run.call.stem}-diff`, between.diff)}`);
        images.push(`previous: ${attach(run, `${run.call.stem}-previous`, unsettled[0])}`);
        images.push(`actual: ${attach(run, `${run.call.stem}-actual`, unsettled[1])}`);
      }
      const message = captures < 2
        ? `took ${captures} screenshot${captures === 1 ? '' : 's'} before the timeout and needs two the same; give it a longer timeout`
        : `the screen never held still: no two of ${captures} screenshots in a row were the same`;
      return failure(run.api, [message, ...images].join('\n'), run.stored, 'no stable screenshot', cause);
    },
  });
  return settled;
}

/**
 * Keeps a screen that held still. With nothing stored and no `update`, the
 * call fails either way: locally the screenshot is written for review; in CI
 * it is only attached, under the path it belongs at, since a CI checkout is
 * thrown away and a retry must not pass against what its first attempt wrote.
 */
async function keep(run: Run, expected: RgbaImage | undefined, settled: RgbaImage): Promise<void> {
  const { store, stored, api } = run;
  if (expected === undefined && !store.update && store.ci) {
    const kept = attach(run, path.join('snapshots', ...stored.shown.split('/')), settled);
    throw failure(api, `no stored screenshot at ${stored.shown}, and CI writes none; commit this run's there\nactual: ${kept}`, stored, 'no stored screenshot');
  }
  mkdirSync(path.dirname(stored.file), { recursive: true });
  await writeFileAtomic(stored.file, encodePng(settled));
  store.written.add(stored.file);
  if (expected === undefined && !store.update) {
    throw failure(api, `no stored screenshot at ${stored.shown}; wrote this run's there. Look at it, commit it, and run again`, stored, 'no stored screenshot');
  }
}

/** `.not`: waits for the screen to differ from the stored screenshot, which must exist. */
async function expectDifferent(run: Run, expected: RgbaImage | undefined, deadline: Deadline): Promise<void> {
  if (expected === undefined) {
    throw failure(run.api, `no stored screenshot at ${run.stored.shown} to differ from`, run.stored, 'no stored screenshot');
  }
  let compared = false;
  let missing: string | undefined;
  await pollCondition({
    deadline,
    signal: run.context.engine.signal,
    negated: true,
    evaluate: async () => {
      const capture = await run.capture();
      if ('missing' in capture) {
        missing = capture.missing;
        return undefined;
      }
      compared = true;
      return compareImages(expected, capture.image, run.call.tolerance).kind === 'match';
    },
    onTimeout: (cause) =>
      compared
        ? failure(run.api, `the screen still matches ${run.stored.shown}`, run.stored, 'matching', cause)
        : failure(run.api, missing ?? 'no screenshot was taken', run.stored, 'no screenshot', cause),
  });
}

/** Reads a stored screenshot; one that is not a PNG fails the call. */
function readStored(api: string, stored: Stored): RgbaImage {
  try {
    return decodePng(readFileSync(stored.file));
  } catch (cause) {
    throw new TestError('INVALID_ARGUMENT', `${api} could not read the stored screenshot ${stored.shown} as a PNG; delete it or run with --update-snapshots`, { cause });
  }
}

/** The failure of a comparison that never matched, the diff, actual, and stored images attached and named in the message. */
function mismatch(
  run: Run,
  expected: RgbaImage,
  actual: RgbaImage,
  comparison: Exclude<ImageComparison, { kind: 'match' }>,
  cause: unknown,
): TestError {
  const { stem } = run.call;
  const images = [
    ...(comparison.kind === 'pixels' ? [`diff: ${attach(run, `${stem}-diff`, comparison.diff)}`] : []),
    `actual: ${attach(run, `${stem}-actual`, actual)}`,
    `expected: ${attach(run, `${stem}-expected`, expected)}`,
  ];
  const { shown } = run.stored;
  const observed = comparison.kind === 'size'
    ? `a ${comparison.actual.width}x${comparison.actual.height} screenshot where ${shown} is ${comparison.expected.width}x${comparison.expected.height}`
    : `${comparison.diffPixels} pixels (${formatRatio(comparison.ratio)} of the image) differ from ${shown}`;
  return failure(run.api, [`${observed}; run with --update-snapshots to keep this run's`, ...images].join('\n'), run.stored, observed, cause);
}

/** An assertion failure naming the stored screenshot. */
function failure(api: string, message: string, stored: Stored, observed: string, cause?: unknown): TestError {
  return new TestError('ASSERTION_FAILED', `${api} failed\n${message}`, {
    details: { expected: stored.shown, observed },
    ...(cause === undefined ? {} : { cause }),
  });
}

/** A share as a percentage with two significant digits at most: `0.04%`, `12%`. */
function formatRatio(ratio: number): string {
  return `${Number((ratio * 100).toPrecision(2))}%`;
}

/**
 * Writes an image into the attempt's results, at `screenshots/<name>.png`, or
 * at `name` itself when it ends in `.png`, and attaches it to the running
 * step. Returns its path as a failure names it: relative to the project root.
 */
function attach(run: Run, name: string, image: RgbaImage): string {
  const { artifacts } = run.store;
  const wanted = name.endsWith('.png') ? name : path.join('screenshots', `${name}.png`);
  let relative = wanted;
  for (let n = 2; existsSync(path.join(artifacts.dir, relative)); n += 1) relative = wanted.replace(/\.png$/, `-${n}.png`);
  const absolute = path.join(artifacts.dir, relative);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, encodePng(image));
  run.context.steps.attachArtifact(artifacts.register('screenshot', relative));
  return path.relative(run.store.projectRoot, absolute).split(path.sep).join('/');
}

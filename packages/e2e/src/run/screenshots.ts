/** Where an attempt's `toHaveScreenshot` calls keep their screenshots, and what the run has written so far. */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ArtifactSink } from './fixtures.ts';

/** Where one attempt keeps its screenshots, and how it names them. */
export interface ScreenshotContext {
  /** The project root; stored screenshots are reported relative to it. */
  readonly projectRoot: string;
  /** Absolute directory of the test file's stored screenshots, `<test file>-snapshots`. */
  readonly directory: string;
  /** Appended to every name so each target and operating system keeps its own: `-<target>-<os>`. */
  readonly suffix: string;
  /** The test's title path, which names a screenshot the test does not name. */
  readonly titlePath: readonly string[];
  /** `--update-snapshots`: a missing or different stored screenshot is written, and the matcher passes. */
  readonly update: boolean;
  /** Without `update`, a CI run never writes into the project: a missing screenshot is only attached to the results. */
  readonly ci: boolean;
  /**
   * Stored screenshots this run wrote. A retry, a repeat, or another test
   * naming the same screenshot compares against an unreviewed file, so the
   * comparison fails rather than passes.
   */
  readonly written: WrittenScreenshots;
  readonly artifacts: ArtifactSink;
  /** Whether a secret fill withholds pixels for the rest of the attempt. */
  withholdsPixels(): boolean;
}

/** What `createScreenshotContext` reads about the attempt. */
export interface ScreenshotContextOptions {
  readonly projectRoot: string;
  readonly ci: boolean;
  readonly update: boolean;
  readonly targetName: string;
  /** The test file, project-relative with `/` separators. */
  readonly file: string;
  readonly titlePath: readonly string[];
  readonly written: WrittenScreenshots;
  readonly artifacts: ArtifactSink;
  withholdsPixels(): boolean;
}

/**
 * The stored screenshots a run wrote, shared by every worker: one empty
 * marker file per screenshot under the run's results directory, which the
 * runner clears of everything but the last report's files before the tests
 * start, so a marker never outlives its run.
 */
export class WrittenScreenshots {
  private readonly directory: string;

  constructor(resultsRoot: string) {
    this.directory = path.join(resultsRoot, '.written-screenshots');
  }

  /** Whether this run wrote the stored screenshot at `file`. */
  has(file: string): boolean {
    return existsSync(this.marker(file));
  }

  /** Records that this run wrote the stored screenshot at `file`. */
  add(file: string): void {
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(this.marker(file), '');
  }

  /** The marker of one stored screenshot, named by a hash of its path. */
  private marker(file: string): string {
    return path.join(this.directory, createHash('sha256').update(file).digest('hex'));
  }
}

/** The screenshot context of one attempt: beside the test file, one file per target and operating system. */
export function createScreenshotContext(options: ScreenshotContextOptions): ScreenshotContext {
  return {
    projectRoot: options.projectRoot,
    directory: path.join(options.projectRoot, `${options.file}-snapshots`),
    suffix: `-${options.targetName}-${process.platform}`,
    titlePath: options.titlePath,
    update: options.update,
    ci: options.ci,
    written: options.written,
    artifacts: options.artifacts,
    withholdsPixels: options.withholdsPixels,
  };
}

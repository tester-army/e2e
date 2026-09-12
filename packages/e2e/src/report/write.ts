/** Atomic report persistence, and the shape of a reporter that writes one file beside the report. */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../internal/atomic-write.ts';
import type { FinishedRun, Reporter } from '../types.ts';

/** Atomically writes one text document, creating the parent directory when it is missing. */
export async function writeTextReport(filePath: string, content: string): Promise<void> {
  mkdirSync(path.dirname(filePath), { recursive: true });
  await writeFileAtomic(filePath, content);
}

/** Atomically writes a wire JSON document with two-space indent and trailing newline. */
export async function writeJsonReport(filePath: string, document: unknown): Promise<void> {
  await writeTextReport(filePath, `${JSON.stringify(document, null, 2)}\n`);
}

/** A path as the report keeps them: POSIX separators whatever the host. */
export function toPosixPath(relative: string): string {
  return relative.split(path.sep).join(path.posix.sep);
}

/**
 * A reporter that renders the finished run into one file beside
 * `report.json` and returns the row naming it, relative to the project root.
 * Nothing to write beside when the report itself was not written.
 */
export function fileReporter(name: string, label: string, fileName: string, render: (run: FinishedRun) => string): Reporter {
  return {
    name,
    async onRunFinished(run) {
      if (run.reportPath === undefined) return;
      const file = path.join(path.dirname(run.reportPath), fileName);
      await writeTextReport(file, render(run));
      return [{ label, text: path.relative(run.projectRoot, file) || file }];
    },
  };
}

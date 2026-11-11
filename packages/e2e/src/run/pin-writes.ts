/**
 * Writing a run's pins, once it ends: the steps files beside the tests, and
 * the actions of each call with a `steps` option into the call.
 *
 * Workers stage what their attempts pin and hand it over on the attempt
 * record; this module is the one writer, so two workers running the tests
 * of one file never race on its steps file. Like a snapshot update, a pin
 * that cannot be written is told, never a failed run.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '../internal/atomic-write.ts';
import { canonicalJson } from '../internal/ids.ts';
import { errorMessage } from '../internal/errors.ts';
import { rewriteInlineSteps, type InlineEdit } from '../cache/inline-steps.ts';
import { inlineStepsOf, mergePinsFile, pinIdKey, pinsFileFor, type AttemptPinWrites, type PinnedStep, type PinSkip, type PinWrite } from '../cache/pins.ts';

/** What writing a run's pins came to, as lines for the terminal. */
export interface PinsWritten {
  readonly lines: readonly string[];
}

/**
 * Writes every pin the run's attempts staged. The inline ones first: a call
 * whose actions could not be written into the test file keeps no entry in
 * its steps file either, and a call that ran with different actions (in a
 * loop, or a helper several tests call) cannot hold one list, so it is
 * left as it is, as Vitest refuses two inline snapshots at one location.
 */
export async function writePins(projectRoot: string, attempts: readonly AttemptPinWrites[]): Promise<PinsWritten> {
  const lines: string[] = [];
  const skipped: PinSkip[] = attempts.flatMap((attempt) => attempt.skipped);
  const writes = attempts.flatMap((attempt) => attempt.writes);
  const sidecar = writes.filter((write) => write.inline === undefined);
  const inline = writes.filter((write) => write.inline !== undefined);

  const located = new Map<string, PinWrite[]>();
  for (const write of inline) {
    const at = write.inline!;
    const key = `${at.file}:${String(at.line)}:${String(at.column)}`;
    located.set(key, [...(located.get(key) ?? []), write]);
  }
  const byFile = new Map<string, { edit: InlineEdit; writes: PinWrite[] }[]>();
  for (const [where, group] of located) {
    const lists = new Set(group.map((write) => canonicalJson(inlineStepsOf(write.step.trace))));
    if (lists.size > 1) {
      lines.push(`${where}: not written: the call ran with ${lists.size} different lists of actions; take steps out of it, and --pin keeps each run of it in the steps file`);
      continue;
    }
    const at = group[0]!.inline!;
    const edits = byFile.get(at.file) ?? [];
    edits.push({ edit: { line: at.line, column: at.column, steps: inlineStepsOf(group[0]!.step.trace) }, writes: group });
    byFile.set(at.file, edits);
  }
  const pinnedInline: PinWrite[] = [];
  for (const [file, edits] of byFile) {
    const absolute = path.resolve(projectRoot, file);
    try {
      const source = await readFile(absolute, 'utf8');
      const { code, missed } = rewriteInlineSteps(file, source, edits.map(({ edit }) => edit));
      for (const edit of missed) lines.push(`${file}:${String(edit.line)}: not written: no agent.act() call with a steps: [...] option starts there`);
      const written = edits.filter(({ edit }) => !missed.includes(edit));
      if (code !== source) await writeFileAtomic(absolute, code);
      for (const { writes: group } of written) pinnedInline.push(...group);
      if (written.length > 0) lines.push(`${file}: ${plural(written.length, 'call')} pinned inline`);
    } catch (cause) {
      lines.push(`${file}: not written: ${errorMessage(cause)}`);
    }
  }

  const byTestFile = new Map<string, PinnedStep[]>();
  for (const write of [...sidecar, ...pinnedInline]) byTestFile.set(write.file, [...(byTestFile.get(write.file) ?? []), write.step]);
  for (const [testFile, steps] of byTestFile) {
    const file = pinsFileFor(testFile);
    try {
      const changed = await mergePinsFile(path.resolve(projectRoot, file), steps);
      const distinct = new Set(steps.map(pinIdKey)).size;
      lines.push(changed === 0 ? `${file}: ${plural(distinct, 'step')} already pinned as recorded` : `${file}: ${plural(changed, 'step')} pinned`);
    } catch (cause) {
      lines.push(`${file}: not written: ${errorMessage(cause)}`);
    }
  }

  for (const skip of skipped) {
    lines.push(`${skip.file} › ${skip.test.join(' › ')}: not pinned "${skip.instruction}": ${skip.reason}`);
  }
  return { lines };
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

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
import { inlineStepsOf, mergePinsFile, pinIdKey, pinnedFlow, pinsFileFor, type AttemptPinWrites, type PinnedStep, type PinSkip, type PinWrite } from '../cache/pins.ts';

/** What writing a run's pins came to, as lines for the terminal. */
export interface PinsWritten {
  readonly lines: readonly string[];
}

/**
 * Writes every pin the run's attempts staged. A call that ran with different
 * actions (in a loop, or a helper several tests call) cannot hold one list,
 * so it is left as it is, as Vitest refuses two inline snapshots at one
 * location; a step recorded differently by several runs of it
 * (`--repeat-each`) is left alone the same way. The steps files go first:
 * a test file gets its inline actions only once the rest of their recording
 * is written, so a failed write never leaves actions with nothing to check.
 */
export async function writePins(projectRoot: string, attempts: readonly AttemptPinWrites[]): Promise<PinsWritten> {
  const inlineLines: string[] = [];
  const stepLines: string[] = [];
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
      inlineLines.push(`${where}: not written: the call ran with ${lists.size} different lists of actions; take steps out of it, and --pin keeps each run of it in the steps file`);
      continue;
    }
    const at = group[0]!.inline!;
    const edits = byFile.get(at.file) ?? [];
    edits.push({ edit: { line: at.line, column: at.column, steps: inlineStepsOf(group[0]!.step.trace) }, writes: group });
    byFile.set(at.file, edits);
  }
  // A first pass finds the calls each file holds; the edits are applied
  // once the steps files are written, each call only if its steps were.
  const rewrites: { file: string; absolute: string; source: string; edits: { edit: InlineEdit; writes: PinWrite[] }[] }[] = [];
  for (const [file, edits] of byFile) {
    const absolute = path.resolve(projectRoot, file);
    try {
      const source = await readFile(absolute, 'utf8');
      const { missed } = rewriteInlineSteps(file, source, edits.map(({ edit }) => edit));
      for (const edit of missed) inlineLines.push(`${file}:${String(edit.line)}: not written: no agent.act() call with a steps: [...] option starts there`);
      const found = edits.filter(({ edit }) => !missed.includes(edit));
      if (found.length > 0) rewrites.push({ file, absolute, source, edits: found });
    } catch (cause) {
      inlineLines.push(`${file}: not written: ${errorMessage(cause)}`);
    }
  }

  const byTestFile = new Map<string, PinWrite[]>();
  for (const write of [...sidecar, ...rewrites.flatMap((rewrite) => rewrite.edits.flatMap((edit) => edit.writes))]) byTestFile.set(write.file, [...(byTestFile.get(write.file) ?? []), write]);
  const unwritten = new Set<string>();
  const refused = new Set<PinWrite>();
  for (const [testFile, group] of byTestFile) {
    const file = pinsFileFor(testFile);
    const steps = agreeingSteps(group, (runs) => {
      for (const run of runs) refused.add(run);
      const write = runs[0]!;
      const count = runs.length;
      stepLines.push(`${file}: not written for "${write.step.instruction}" in ${write.step.test.join(' › ')}: its ${String(count)} runs recorded different flows; pin it in a run that runs it once`);
    });
    try {
      const changed = await mergePinsFile(path.resolve(projectRoot, file), steps);
      stepLines.push(changed === 0 ? `${file}: ${plural(steps.length, 'step')} already pinned as recorded` : `${file}: ${plural(changed, 'step')} pinned`);
    } catch (cause) {
      unwritten.add(testFile);
      stepLines.push(`${file}: not written: ${errorMessage(cause)}`);
    }
  }

  for (const rewrite of rewrites) {
    const kept = rewrite.edits.filter(({ edit, writes: group }) => {
      if (!group.some((write) => unwritten.has(write.file) || refused.has(write))) return true;
      inlineLines.push(`${rewrite.file}:${String(edit.line)}: not written: the steps file that keeps the rest of its recording was not written`);
      return false;
    });
    if (kept.length === 0) continue;
    try {
      const { code } = rewriteInlineSteps(rewrite.file, rewrite.source, kept.map(({ edit }) => edit));
      if (code !== rewrite.source) await writeFileAtomic(rewrite.absolute, code);
      inlineLines.push(`${rewrite.file}: ${plural(kept.length, 'call')} pinned inline`);
    } catch (cause) {
      inlineLines.push(`${rewrite.file}: not written: ${errorMessage(cause)}`);
    }
  }

  const lines = [...inlineLines, ...stepLines];
  for (const skip of skipped) {
    lines.push(`${skip.file} › ${skip.test.join(' › ')}: not pinned "${skip.instruction}": ${skip.reason}`);
  }
  return { lines };
}

/** One step per identity: several runs of a step that recorded one flow write it once, and ones that disagree are reported and left out. */
function agreeingSteps(writes: readonly PinWrite[], disagree: (writes: readonly PinWrite[]) => void): PinnedStep[] {
  const byId = new Map<string, PinWrite[]>();
  for (const write of writes) {
    const key = pinIdKey(write.step);
    byId.set(key, [...(byId.get(key) ?? []), write]);
  }
  const steps: PinnedStep[] = [];
  for (const group of byId.values()) {
    if (new Set(group.map((write) => pinnedFlow(write.step))).size > 1) disagree(group);
    else steps.push(group[0]!.step);
  }
  return steps;
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

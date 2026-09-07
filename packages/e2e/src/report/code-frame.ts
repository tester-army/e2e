/**
 * Failure-location presentation: finds the user's failing line in a stack and
 * renders a small annotated code frame around it, in vitest's frame style.
 * Generic over reporters; the list reporter is simply its first consumer.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bounded, terminalColumns, type Colors } from './format.ts';

/** Lines of context on each side of the failing line. */
const FRAME_RANGE = 2;
/** A source line longer than this is minified output; the frame would be noise. */
const MAX_FRAME_LINE_CHARS = 200;

export interface StackFrame {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

const FRAME_PATTERN = /((?:file:\/\/)?\/[^):]+):(\d+):(\d+)\)?\s*$/;

/**
 * First stack frame inside the project and outside node_modules: the line in
 * the user's test file that the failure unwound through. Runner frames never
 * match because the runner lives in node_modules (or outside the project root
 * in a workspace).
 */
export function userFrame(
  stack: string | undefined,
  projectRoot: string | undefined,
): StackFrame | undefined {
  if (stack === undefined || projectRoot === undefined) return undefined;
  for (const raw of stack.split('\n')) {
    const match = FRAME_PATTERN.exec(raw);
    if (match === null) continue;
    const [, location, line, column] = match as unknown as [string, string, string, string];
    const withoutQuery = location.split('?')[0]!;
    let file: string;
    try {
      file = withoutQuery.startsWith('file://') ? fileURLToPath(withoutQuery) : withoutQuery;
    } catch {
      continue;
    }
    if (!file.startsWith(`${projectRoot}${path.sep}`)) continue;
    if (file.includes(`${path.sep}node_modules${path.sep}`)) continue;
    return { file, line: Number(line), column: Number(column) };
  }
  return undefined;
}

/**
 * Renders the failing line with two lines of context on each side and a
 * column caret, gutter-numbered like vitest (`  28| code`).
 */
export function codeFrame(frame: StackFrame, pc: Colors): string[] {
  let source: string;
  try {
    source = readFileSync(frame.file, 'utf8');
  } catch {
    return [];
  }
  const lines = source.split(/\r?\n/);
  const index = frame.line - 1;
  if (index < 0 || index >= lines.length) return [];
  const start = Math.max(0, index - FRAME_RANGE);
  const end = Math.min(lines.length - 1, index + FRAME_RANGE);
  const maxChars = Math.max(20, terminalColumns() - 10);
  const gutter = (no: number | '' = ''): string => pc.gray(`${String(no).padStart(3)}|`);
  const rows: string[] = [];
  for (let i = start; i <= end; i += 1) {
    const raw = bounded(lines[i] ?? '').replaceAll('\t', ' ');
    if (raw.length > MAX_FRAME_LINE_CHARS) return [];
    const text = raw.length > maxChars ? `${raw.slice(0, maxChars - 1)}…` : raw.trimEnd();
    rows.push(`${gutter(i + 1)}${text === '' ? '' : ` ${text}`}`);
    if (i === index) {
      rows.push(`${gutter()}${' '.repeat(Math.max(1, frame.column))}${pc.red('^')}`);
    }
  }
  return rows;
}

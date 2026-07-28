/**
 * Failure-location presentation: finds the user's failing line in a stack and
 * renders a small annotated code frame around it. Generic over reporters; the
 * list reporter is simply its first consumer.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';
import { sanitizeText, truncateUtf8 } from '../internal/errors.ts';

const MAX_FIELD_BYTES = 8192;

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

/** Renders the failing line with one line of context and a column caret. */
export function codeFrame(frame: StackFrame): string[] {
  let source: string;
  try {
    source = readFileSync(frame.file, 'utf8');
  } catch {
    return [];
  }
  const lines = source.split('\n');
  const index = frame.line - 1;
  if (index < 0 || index >= lines.length) return [];
  const start = Math.max(0, index - 1);
  const end = Math.min(lines.length - 1, index + 1);
  const width = String(end + 1).length;
  const rows: string[] = [];
  for (let i = start; i <= end; i += 1) {
    const text = truncateUtf8(sanitizeText(lines[i] ?? ''), MAX_FIELD_BYTES);
    const number = String(i + 1).padStart(width);
    if (i === index) {
      rows.push(`${pc.red('>')} ${number} | ${text}`);
      rows.push(`  ${' '.repeat(width)} | ${' '.repeat(Math.max(0, frame.column - 1))}${pc.red('^')}`);
    } else {
      rows.push(pc.dim(`  ${number} | ${text}`));
    }
  }
  return rows;
}

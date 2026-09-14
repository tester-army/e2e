/**
 * Where in the project a stack unwound through. Shared by the step recorder
 * (every step names the test line it was called from), the error serializer
 * (a failure names the line it unwound through), and the list reporter's
 * code frame, so the three agree on what counts as the user's line.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** A position in a source file. Absolute in a `StackFrame`, project-relative POSIX in a `SourceLocation`. */
export interface StackFrame {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

/** A position the report keeps: the file relative to the project root, POSIX separators, one-based line and column. */
export type SourceLocation = StackFrame;

const FRAME_PATTERN = /((?:file:\/\/)?\/[^):]+):(\d+):(\d+)\)?\s*$/;

/**
 * First stack frame inside the project and outside node_modules: the line in
 * the user's test file that the failure unwound through. Runner frames never
 * match because the runner lives in node_modules (or outside the project root
 * in a workspace).
 */
export function userFrame(stack: string | undefined, projectRoot: string | undefined): StackFrame | undefined {
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

/** The user's frame in a stack as the report keeps it: project-relative, POSIX; nothing when the stack named no project line. */
export function sourceLocation(stack: string | undefined, projectRoot: string | undefined): SourceLocation | undefined {
  const frame = userFrame(stack, projectRoot);
  if (frame === undefined || projectRoot === undefined) return undefined;
  const relative = frame.file.slice(projectRoot.length).replace(/^[/\\]/, '').split(path.sep).join('/');
  return { file: relative, line: Math.max(1, frame.line), column: Math.max(1, frame.column) };
}

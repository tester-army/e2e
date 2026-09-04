/**
 * One capture of a pane: what tmux reports about it (cursor, size, mouse
 * mode, liveness, title) plus every visible row as plain text. Captured in a
 * single tmux invocation so the metadata and the rows describe one moment.
 */

import { failure } from './support.ts';

export interface ScreenCapture {
  /** Visible rows, top to bottom, exactly `height` of them, trailing blanks trimmed. */
  readonly lines: readonly string[];
  readonly cursor: { readonly x: number; readonly y: number; readonly visible: boolean };
  readonly width: number;
  readonly height: number;
  /** Whether the program turned any mouse reporting mode on. */
  readonly mouse: boolean;
  /** Whether the program is on its alternate screen (most full-screen TUIs are). */
  readonly alternate: boolean;
  /** Whether the program has exited; the pane then shows its final screen. */
  readonly dead: boolean;
  readonly exitStatus?: number;
  /** The program's own name for the pane, set through the terminal title sequence. */
  readonly title: string;
  /** The foreground command tmux sees in the pane. */
  readonly command: string;
}

/** Format handed to `display-message -p`, one tab-separated line; the title is last because it is free text. */
const CAPTURE_FORMAT = [
  '#{cursor_x}',
  '#{cursor_y}',
  '#{cursor_flag}',
  '#{pane_width}',
  '#{pane_height}',
  '#{mouse_any_flag}',
  '#{alternate_on}',
  '#{pane_dead}',
  '#{pane_dead_status}',
  '#{pane_current_command}',
  '#{pane_title}',
].join('\t');

/** Arguments for one combined `display-message ; capture-pane` invocation on a target. */
export function captureArgs(target: string): string[] {
  return ['display-message', '-p', '-t', target, CAPTURE_FORMAT, ';', 'capture-pane', '-p', '-t', target];
}

function integer(value: string | undefined, name: string): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (Number.isNaN(parsed)) throw failure(`tmux reported no ${name} for the pane`);
  return parsed;
}

/** Parses the output of `captureArgs`: the metadata line, then the rows. */
export function parseCapture(output: string): ScreenCapture {
  const [meta, ...rest] = output.split('\n');
  if (meta === undefined || meta === '') throw failure('tmux returned an empty pane capture');
  const fields = meta.split('\t');
  const width = integer(fields[3], 'width');
  const height = integer(fields[4], 'height');
  const dead = fields[7] === '1';
  const exitStatus = dead ? Number.parseInt(fields[8] ?? '', 10) : Number.NaN;
  // capture-pane ends with a newline, so the split leaves one empty tail.
  if (rest.at(-1) === '') rest.pop();
  const lines: string[] = rest.slice(0, height).map((line) => line.trimEnd());
  while (lines.length < height) lines.push('');
  return {
    lines,
    cursor: { x: integer(fields[0], 'cursor column'), y: integer(fields[1], 'cursor row'), visible: fields[2] === '1' },
    width,
    height,
    mouse: fields[5] === '1',
    alternate: fields[6] === '1',
    dead,
    ...(Number.isNaN(exitStatus) ? {} : { exitStatus }),
    command: fields[9] ?? '',
    title: fields.slice(10).join('\t'),
  };
}

/** The visible screen as one string: rows joined by newlines, trailing blank rows dropped. */
export function screenText(screen: ScreenCapture): string {
  const lines = [...screen.lines];
  while (lines.length > 0 && lines.at(-1) === '') lines.pop();
  return lines.join('\n');
}

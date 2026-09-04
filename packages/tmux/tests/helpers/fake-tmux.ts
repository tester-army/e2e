/**
 * A scripted tmux runner: every command line the backend issues is recorded
 * and answered from a canned screen, so tests assert on the exact tmux
 * arguments the backend produced, which is the whole of what this backend
 * owes tmux.
 */

import type { TmuxRunner } from '../../src/tmux.ts';

export interface FakeScreen {
  lines: string[];
  cursor: { x: number; y: number; visible: boolean };
  width: number;
  height: number;
  mouse: boolean;
  alternate: boolean;
  dead: boolean;
  exitStatus?: number;
  command: string;
  title: string;
}

export interface FakeTmux {
  readonly runner: TmuxRunner;
  /** Every command line issued, as its argument array. */
  readonly calls: string[][];
  /** The socket names the backend asked runners for. */
  readonly sockets: string[];
  /** The screen the next captures report; mutate it to script the program. */
  readonly screen: FakeScreen;
  /** Command names issued so far, in order (`new-session`, `send-keys`, ...). */
  commands(): string[];
  /** Every call whose first argument is `command`. */
  of(command: string): string[][];
  /** Replaces the runner for one command with a failure. */
  fail(command: string, error: Error): void;
  /** The factory to hand `TmuxSurface`. */
  factory(tmuxPath: string, socket: string): TmuxRunner;
}

/** An OpenCode-like home screen: a prompt row under the cursor, a status row, mouse reporting on. */
export function openCodeScreen(): FakeScreen {
  return {
    lines: [
      '',
      '   |  Ask anything... "Fix a TODO in the codebase"',
      '',
      '   |  Build - Claude Haiku 4.5 (latest) Anthropic',
      '                         tab agents  ctrl+p commands',
      '',
    ],
    cursor: { x: 6, y: 1, visible: true },
    width: 60,
    height: 6,
    mouse: true,
    alternate: true,
    dead: false,
    command: 'opencode',
    title: 'OpenCode',
  };
}

function render(screen: FakeScreen): string {
  const meta = [
    screen.cursor.x,
    screen.cursor.y,
    screen.cursor.visible ? 1 : 0,
    screen.width,
    screen.height,
    screen.mouse ? 1 : 0,
    screen.alternate ? 1 : 0,
    screen.dead ? 1 : 0,
    screen.dead ? (screen.exitStatus ?? '') : '',
    screen.command,
    screen.title,
  ].join('\t');
  return `${meta}\n${screen.lines.join('\n')}\n`;
}

export function createFakeTmux(screen: FakeScreen = openCodeScreen()): FakeTmux {
  const calls: string[][] = [];
  const sockets: string[] = [];
  const failures = new Map<string, Error>();
  let windows = 0;
  const runner: TmuxRunner = async (args) => {
    const list = [...args];
    calls.push(list);
    const command = list[0] ?? '';
    const failure = failures.get(command);
    if (failure !== undefined) throw failure;
    switch (command) {
      case 'new-window':
        windows += 1;
        return `@${windows}\n`;
      case 'display-message':
        return render(screen);
      case 'capture-pane':
        return `${screen.lines.join('\n')}\n`;
      default:
        return '';
    }
  };
  return {
    runner,
    calls,
    sockets,
    screen,
    commands: () => calls.map((call) => call[0] ?? ''),
    of: (command) => calls.filter((call) => call[0] === command),
    fail: (command, error) => {
      failures.set(command, error);
    },
    factory: (_tmuxPath, socket) => {
      sockets.push(socket);
      return runner;
    },
  };
}

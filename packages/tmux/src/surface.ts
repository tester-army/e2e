/**
 * The tmux surface: one private tmux server per run, one session per worker,
 * one window per attempt running the program under test. It owns the id
 * space (one fresh generation per observation), the attempt state, and every
 * translation between the contract's vocabulary and tmux commands: a `tap`
 * is a synthetic mouse click written into the pane as the escape sequence a
 * terminal would send, a `fill` is `send-keys -l`, a `press` is a tmux key
 * name. The runner owns everything else.
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import {
  BackendError,
  InfrastructureError,
  type BackendAttemptContext,
  type BackendCleanupContext,
  type BackendInitInfo,
  type BackendPrepareInfo,
  type BackendSnapshot,
  type LocatorAction,
  type LocatorExpression,
  type Momentum,
  type NodeRef,
  type OperationContext,
  type ScrollDirection,
  type SemanticNode,
} from '@e2edev/e2e/backend';
import { keyArgs } from './keys.ts';
import { resolveExpression } from './locate.ts';
import { projectScreen, type ProjectedNode, type ProjectedScreen } from './nodes.ts';
import { captureArgs, parseCapture, screenText, type ScreenCapture } from './screen.ts';
import { cancelled, invalidState, notActionable, screenUrl, sleep, slug, unsupported, withinCleanupBudget } from './support.ts';
import { createTmuxRunner, type TmuxRunner } from './tmux.ts';

export interface TmuxOptions {
  /**
   * Shell command started fresh in its own tmux window at the start of every
   * attempt: the program under test (`'opencode'`, `'vim README.md'`,
   * `'node dist/cli.js'`). It runs through tmux's default shell, so pipes
   * and quoting work as they do at a prompt.
   */
  readonly command: string;
  /** Working directory of the program, resolved against the project root. Defaults to the project root. */
  readonly cwd?: string;
  /** Environment variables added to the program's environment. */
  readonly env?: Readonly<Record<string, string>>;
  /** Pane width in cells. Default 120. */
  readonly columns?: number;
  /** Pane height in cells. Default 40. */
  readonly rows?: number;
  /**
   * Text the screen must show before an attempt starts, for programs with a
   * startup phase. Without it the attempt starts once the screen holds still
   * for a moment, bounded by the launch timeout either way.
   */
  readonly ready?: string | RegExp;
  /** tmux session name; defaults to `e2e-<target name>`. */
  readonly session?: string;
  /** The tmux binary; defaults to `tmux` on `PATH`. */
  readonly tmuxPath?: string;
}

/** Mints the tmux runner for one socket; the seam unit tests script. */
export type RunnerFactory = (tmuxPath: string, socket: string) => TmuxRunner;

interface Attempt {
  readonly attemptId: string;
  readonly windowId: string;
}

/** Wire mouse buttons of the SGR (1006) mouse protocol, the mode every modern TUI enables. */
const MOUSE_BUTTON = { left: 0, wheelUp: 64, wheelDown: 65, wheelLeft: 66, wheelRight: 67 } as const;
const DEFAULT_COLUMNS = 120;
const DEFAULT_ROWS = 40;
const READY_POLL_MS = 100;
const SETTLE_POLL_MS = 150;
const SETTLE_TIMEOUT_MS = 3_000;
/** Program that keeps the session alive between attempts; it does nothing and never exits on its own. */
const HOLDER_COMMAND = 'tail -f /dev/null';

/**
 * Hex bytes of one SGR mouse report (`ESC [ < button ; column ; row M`),
 * the way `send-keys -H` wants them. Cells are zero-based here and one-based
 * on the wire.
 */
function mouseReport(button: number, column: number, row: number, release: boolean): string[] {
  const sequence = `\u001b[<${button};${column + 1};${row + 1}${release ? 'm' : 'M'}`;
  return [...Buffer.from(sequence, 'utf8')].map((byte) => byte.toString(16).padStart(2, '0'));
}

function matches(pattern: string | RegExp, line: string): boolean {
  return typeof pattern === 'string' ? line.includes(pattern) : pattern.test(line);
}

export class TmuxSurface {
  private runner: TmuxRunner | undefined;
  private session = '';
  private socket = '';
  private attempt: Attempt | undefined;
  private generation = new Map<string, ProjectedNode>();
  private idCounter = 0;
  private projectRoot = process.cwd();
  private headed = false;
  /** Whether the headed terminal window has been opened for this session. */
  private attached = false;

  constructor(
    readonly options: TmuxOptions,
    private readonly createRunner: RunnerFactory = createTmuxRunner,
  ) {
    if (typeof options.command !== 'string' || options.command.trim() === '') {
      throw new BackendError('INVALID_STATE', 'tmux backend needs a `command` to run', { retryable: false });
    }
  }

  /** Whether an attempt is running on this surface right now. */
  get attemptRunning(): boolean {
    return this.attempt !== undefined;
  }

  /** The program's working directory, resolved against the project root init reported. */
  get cwd(): string {
    return path.resolve(this.projectRoot, this.options.cwd ?? '.');
  }

  private get tmuxPath(): string {
    return this.options.tmuxPath ?? 'tmux';
  }

  /** The running attempt's window, the target of every pane command; INVALID_STATE outside an attempt. */
  private target(): string {
    if (this.attempt === undefined) throw invalidState('no tmux window is open; the surface acts inside an attempt only');
    return this.attempt.windowId;
  }

  /** Runs one tmux command against the worker's server. */
  private async tmux(args: readonly string[], signal?: AbortSignal): Promise<string> {
    if (this.runner === undefined) throw invalidState('the tmux backend is not initialized');
    return this.runner(args, signal);
  }

  /** Once per run: the binary must exist and answer `-V`, or the run ends before any test. */
  async prepare(info: BackendPrepareInfo): Promise<void> {
    const version = await new Promise<string>((resolve, reject) => {
      execFile(this.tmuxPath, ['-V'], { encoding: 'utf8', signal: info.signal }, (error, stdout) => {
        if (error === null) resolve(stdout.trim());
        else reject(error);
      });
    }).catch((cause: unknown) => {
      throw new InfrastructureError(
        'TMUX_UNAVAILABLE',
        `tmux backend for target "${info.targetName}": cannot run "${this.tmuxPath} -V"; install tmux (brew install tmux, apt install tmux) or set the backend option \`tmuxPath\``,
        { cause },
      );
    });
    info.log(`${version} ready for target "${info.targetName}"`);
  }

  /**
   * Once per worker: a private server on a per-run socket, one session
   * holding a placeholder window so the session outlives every attempt's
   * window, and the options that make a pane observable: the program's exit
   * keeps its final screen, the status bar is off so it never shows up in a
   * capture, and the size is pinned so an attached viewer cannot resize it.
   */
  async init(info: BackendInitInfo): Promise<void> {
    this.projectRoot = info.projectRoot;
    this.headed = info.headed;
    this.socket = `e2e-${slug(info.runId)}`;
    this.session = this.options.session ?? `e2e-${info.targetName}`;
    this.runner = this.createRunner(this.tmuxPath, this.socket);
    await this.tmux(['kill-session', '-t', `=${this.session}`], info.signal).catch(() => undefined);
    const option = (name: string, value: string): string[] => [';', 'set-option', '-g', '-q', name, value];
    await this.tmux(
      [
        'new-session',
        '-d',
        '-s',
        this.session,
        '-x',
        String(this.options.columns ?? DEFAULT_COLUMNS),
        '-y',
        String(this.options.rows ?? DEFAULT_ROWS),
        '-c',
        this.cwd,
        HOLDER_COMMAND,
        ...option('remain-on-exit', 'on'),
        ...option('status', 'off'),
        ...option('history-limit', '10000'),
        ...option('escape-time', '0'),
        ...option('set-titles', 'off'),
        ...option('allow-rename', 'on'),
        // Pinned on the session, not globally: tmux 3.6 exits on the next
        // new-window when a global manual size meets any other global option.
        ';', 'set-option', '-t', this.session, '-q', 'window-size', 'manual',
      ],
      info.signal,
    );
    if (this.headed && !this.attached) {
      await this.attachViewer(info.signal);
      this.attached = true;
    }
  }

  /**
   * `--headed`: a terminal window attached to the session, so a person can
   * watch the run type. macOS only, through Terminal.app; elsewhere the
   * session is reachable by hand with the attach command the README gives.
   */
  private async attachViewer(signal: AbortSignal): Promise<void> {
    if (process.platform !== 'darwin') return;
    const attach = `${this.tmuxPath} -L ${this.socket} attach-session -t ${this.session}`;
    await new Promise<void>((resolve) => {
      execFile(
        'osascript',
        ['-e', `tell application "Terminal" to do script ${JSON.stringify(attach)}`, '-e', 'tell application "Terminal" to activate'],
        { signal },
        () => resolve(),
      );
    });
  }

  /** Before each attempt: a fresh window running the program, on screen and ready. */
  async startAttempt(context: BackendAttemptContext): Promise<void> {
    if (this.attempt !== undefined) throw invalidState('an attempt is already running on this tmux backend');
    this.generation = new Map();
    const windowId = await this.openWindow(context.signal);
    this.attempt = { attemptId: context.attemptId, windowId };
    await this.awaitReady(context.signal);
  }

  private async openWindow(signal: AbortSignal): Promise<string> {
    const env = Object.entries(this.options.env ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
    const output = await this.tmux(
      ['new-window', '-P', '-F', '#{window_id}', '-t', `${this.session}:`, '-c', this.cwd, ...env, '--', this.options.command],
      signal,
    );
    const windowId = output.trim();
    if (windowId === '') throw invalidState('tmux new-window reported no window id');
    return windowId;
  }

  /**
   * Waits for the program's first screen: the `ready` text when one is
   * configured, else a screen that holds still across two polls. The launch
   * timeout is the bound in both cases; a program that never shows its
   * ready text fails the attempt launch with the screen it did show.
   */
  private async awaitReady(signal: AbortSignal): Promise<void> {
    const ready = this.options.ready;
    if (ready !== undefined) {
      for (;;) {
        const screen = await this.capture(signal);
        if (screen.lines.some((line) => matches(ready, line))) return;
        if (screen.dead) {
          throw invalidState(
            `the program exited (status ${screen.exitStatus ?? 'unknown'}) before showing ${String(ready)}; screen:\n${screenText(screen)}`,
          );
        }
        try {
          await sleep(READY_POLL_MS, signal, 'waiting for the ready text');
        } catch {
          throw cancelled(`the program did not show ${String(ready)} within the launch timeout; screen:\n${screenText(screen)}`);
        }
      }
    }
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    let previous = screenText(await this.capture(signal));
    while (Date.now() < deadline) {
      await sleep(SETTLE_POLL_MS, signal, 'settling the first screen');
      const next = screenText(await this.capture(signal));
      if (next === previous && next !== '') return;
      previous = next;
    }
  }

  /** After each attempt: the program's window goes, whatever state it is in. Idempotent. */
  async endAttempt(context: BackendCleanupContext): Promise<void> {
    const attempt = this.attempt;
    this.attempt = undefined;
    this.generation = new Map();
    if (attempt === undefined) return;
    await withinCleanupBudget(this.tmux(['kill-window', '-t', attempt.windowId]).catch(() => undefined), context);
  }

  /** Worker shutdown: the session goes; the server exits with its last session. */
  async dispose(context: BackendCleanupContext): Promise<void> {
    const runner = this.runner;
    const session = this.session;
    this.runner = undefined;
    this.attempt = undefined;
    this.attached = false;
    this.generation = new Map();
    if (runner === undefined || session === '') return;
    await withinCleanupBudget(runner(['kill-session', '-t', `=${session}`]).catch(() => undefined), context);
  }

  /** One capture of the attempt's pane. */
  async capture(signal?: AbortSignal): Promise<ScreenCapture> {
    return parseCapture(await this.tmux(captureArgs(this.target()), signal));
  }

  private project(screen: ScreenCapture): ProjectedScreen {
    return projectScreen(screen, () => {
      this.idCounter += 1;
      return `n${this.idCounter}`;
    });
  }

  async observe(operation: OperationContext): Promise<BackendSnapshot> {
    const projected = this.project(await this.capture(operation.signal));
    this.generation = new Map(projected.index.map((entry) => [entry.id, entry]));
    return { nodes: [projected.root], viewport: projected.viewport };
  }

  /**
   * The located screen joins the current generation instead of replacing
   * it, so an observation's ids stay valid across a `screen` query in the
   * same step.
   */
  async locate(expression: LocatorExpression, operation: OperationContext): Promise<readonly SemanticNode[]> {
    const projected = this.project(await this.capture(operation.signal));
    const found = resolveExpression(expression, projected.index);
    for (const entry of projected.index) this.generation.set(entry.id, entry);
    return found.map((entry) => entry.node);
  }

  private resolveRef(ref: NodeRef): ProjectedNode {
    const entry = this.generation.get(ref.id);
    if (entry === undefined) {
      throw new BackendError('NODE_STALE', `node ${ref.id} is not part of the newest observation`, { retryable: true });
    }
    return entry;
  }

  /** Sends tmux key names or chords (`Enter`, `C-c`, `M-x`) to the pane, as typed. */
  async sendKeys(keys: readonly string[], signal?: AbortSignal): Promise<void> {
    if (keys.length === 0) return;
    await this.tmux(['send-keys', '-t', this.target(), ...keys], signal);
  }

  /** Types text literally: every character is input, none is tmux syntax. */
  async typeText(text: string, signal?: AbortSignal): Promise<void> {
    if (text === '') return;
    await this.tmux(['send-keys', '-t', this.target(), '-l', '--', text], signal);
  }

  /** Presses one key named the browser way or the tmux way. */
  async pressKey(key: string, signal?: AbortSignal): Promise<void> {
    await this.tmux(['send-keys', '-t', this.target(), ...keyArgs(key)], signal);
  }

  /**
   * Writes mouse clicks into the pane as the SGR reports a terminal sends,
   * so a program in mouse mode sees a real click at that cell. A program
   * that has not turned mouse reporting on would read the bytes as typed
   * text, so the click is refused instead.
   */
  private async click(column: number, row: number, times: number, signal: AbortSignal): Promise<void> {
    const screen = await this.capture(signal);
    if (!screen.mouse) {
      throw notActionable('the program has not enabled mouse input; drive it with press (arrow keys, Enter, Escape) or type');
    }
    const bytes: string[] = [];
    for (let i = 0; i < times; i += 1) {
      bytes.push(...mouseReport(MOUSE_BUTTON.left, column, row, false), ...mouseReport(MOUSE_BUTTON.left, column, row, true));
    }
    await this.tmux(['send-keys', '-t', this.target(), '-H', ...bytes], signal);
  }

  /** Scrolls at one cell: wheel reports when the program reads the mouse, page keys otherwise. */
  private async wheel(
    direction: ScrollDirection,
    momentum: Momentum | undefined,
    cell: { readonly column: number; readonly row: number },
    signal: AbortSignal,
  ): Promise<void> {
    const screen = await this.capture(signal);
    const notches = momentum === 'fast' ? 9 : momentum === 'slow' ? 1 : 3;
    if (screen.mouse) {
      const button = {
        up: MOUSE_BUTTON.wheelUp,
        down: MOUSE_BUTTON.wheelDown,
        left: MOUSE_BUTTON.wheelLeft,
        right: MOUSE_BUTTON.wheelRight,
      }[direction];
      const bytes = Array.from({ length: notches }, () => mouseReport(button, cell.column, cell.row, false)).flat();
      await this.tmux(['send-keys', '-t', this.target(), '-H', ...bytes], signal);
      return;
    }
    if (direction === 'left' || direction === 'right') {
      throw notActionable('the program has not enabled mouse input and a keyboard cannot scroll sideways');
    }
    await this.tmux(['send-keys', '-t', this.target(), direction === 'up' ? 'PPage' : 'NPage'], signal);
  }

  /** The cell a node's action lands on: the middle of its printed text. */
  private cellOf(entry: ProjectedNode): { column: number; row: number } {
    const rect = entry.node.rect;
    if (rect === undefined || entry.row === undefined) throw notActionable(`node ${entry.id} has no row to act on`);
    return { column: rect.x + Math.floor(rect.width / 2), row: entry.row };
  }

  async perform(ref: NodeRef, action: LocatorAction, operation: OperationContext): Promise<void> {
    const entry = this.resolveRef(ref);
    const signal = operation.signal;
    switch (action.kind) {
      case 'tap':
      case 'doubleTap': {
        const cell = this.cellOf(entry);
        return this.click(cell.column, cell.row, action.kind === 'doubleTap' ? 2 : 1, signal);
      }
      case 'focus':
        // The keyboard is the one input and it is always focused.
        return undefined;
      case 'fill':
        return this.typeText(action.value, signal);
      case 'press':
        return this.pressKey(action.key, signal);
      case 'swipe':
        return this.wheel(action.direction, action.momentum, this.cellOf(entry), signal);
      case 'clear':
      case 'check':
      case 'uncheck':
      case 'hover':
      case 'longPress':
      case 'selectOption':
      case 'setInputFiles':
      case 'dragTo':
      case 'scrollIntoView':
        throw unsupported(`a terminal cannot perform "${action.kind}"; drive the program with press and type`);
    }
  }

  async swipe(direction: ScrollDirection, momentum: Momentum | undefined, operation: OperationContext): Promise<void> {
    const screen = await this.capture(operation.signal);
    const centre = { column: Math.floor(screen.width / 2), row: Math.floor(screen.height / 2) };
    await this.wheel(direction, momentum, centre, operation.signal);
  }

  /** `app.restart()`: the program's window is replaced by a fresh one. */
  async restart(operation: OperationContext): Promise<void> {
    const attempt = this.attempt;
    if (attempt === undefined) throw invalidState('app.restart outside an attempt');
    await this.tmux(['kill-window', '-t', attempt.windowId], operation.signal).catch(() => undefined);
    this.generation = new Map();
    const windowId = await this.openWindow(operation.signal);
    this.attempt = { attemptId: attempt.attemptId, windowId };
    await this.awaitReady(operation.signal);
  }

  /** The path anchor: `app://terminal/<program>/<pane title>`; see `screenUrl`. */
  async url(operation: OperationContext): Promise<string> {
    const screen = await this.capture(operation.signal);
    const program = this.options.command.trim().split(/\s+/)[0] ?? 'program';
    return screenUrl(path.basename(program), screen.title);
  }

  /** The visible screen as text. */
  async text(signal?: AbortSignal): Promise<string> {
    return screenText(await this.capture(signal));
  }

  /** History plus the visible screen, the newest `lines` rows at most. */
  async scrollback(lines: number, signal?: AbortSignal): Promise<string> {
    const count = Math.max(1, Math.floor(lines));
    const output = await this.tmux(['capture-pane', '-p', '-t', this.target(), '-S', `-${count}`], signal);
    const rows = output.split('\n').map((line) => line.trimEnd());
    while (rows.length > 0 && rows.at(-1) === '') rows.pop();
    return rows.slice(-count).join('\n');
  }

  async resize(columns: number, rows: number, signal?: AbortSignal): Promise<void> {
    await this.tmux(['resize-window', '-t', this.target(), '-x', String(columns), '-y', String(rows)], signal);
  }

  /** Polls the screen until a row matches; resolves with that row. */
  async waitForText(pattern: string | RegExp, timeoutMs: number, signal: AbortSignal): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const screen = await this.capture(signal);
      const line = screen.lines.find((candidate) => matches(pattern, candidate));
      if (line !== undefined) return line.trim();
      if (Date.now() >= deadline) {
        throw new BackendError(
          'OPERATION_TIMEOUT',
          `the screen did not show ${String(pattern)} within ${timeoutMs}ms; screen:\n${screenText(screen)}`,
          { retryable: false },
        );
      }
      await sleep(Math.min(READY_POLL_MS, Math.max(0, deadline - Date.now())), signal, 'waiting for text');
    }
  }

  /** Polls until the program exits; resolves with its exit status when tmux knows it. */
  async waitForExit(timeoutMs: number, signal: AbortSignal): Promise<number | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const screen = await this.capture(signal);
      if (screen.dead) return screen.exitStatus;
      if (Date.now() >= deadline) {
        throw new BackendError('OPERATION_TIMEOUT', `the program was still running after ${timeoutMs}ms`, { retryable: false });
      }
      await sleep(Math.min(READY_POLL_MS, Math.max(0, deadline - Date.now())), signal, 'waiting for exit');
    }
  }
}

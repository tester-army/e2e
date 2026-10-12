/**
 * `e2e run --watch`: the run, then a loop that runs again when a test file
 * or the config changes, or when a key asks for it, the way `vitest` does.
 * Every iteration is one complete `run()`, so each writes its report and
 * tears its engines and app down; what the loop owns is the file watcher,
 * the keyboard, and the filters the keys set over the command line's.
 */

import { existsSync, watch as fsWatch } from 'node:fs';
import path from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import { Writable } from 'node:stream';
import * as clack from '@clack/prompts';
import picocolors from 'picocolors';
import { discoverConfig } from '../config/load.ts';
import { compileGlobList, literalPrefix, matchesGlob, type CompiledGlobList } from '../internal/globs.ts';
import type { RunOptions, RunOutcome } from '../run/runner.ts';
import type { SignalLadder } from './signals.ts';

/** What asks for a run: the terminal names it in the banner above the run. */
export type WatchTrigger =
  | { readonly kind: 'start' }
  | { readonly kind: 'files'; readonly files: readonly string[] }
  | { readonly kind: 'config' }
  | { readonly kind: 'key'; readonly key: 'a' | 'r' | 'f' | 'u' };

/** The filters the keys set, over the command line's: a positional (`p`) and a title pattern (`t`). */
export interface WatchFilters {
  readonly file: string | undefined;
  readonly title: RegExp | undefined;
}

export const NO_FILTERS: WatchFilters = { file: undefined, title: undefined };

/**
 * The options of the next run: the command line's, with the trigger's
 * selection over them. `--last-failed` is the first run's alone; `f` asks
 * for it again, against the report the run before wrote, and a run with
 * nothing failed is then an empty pass, not `NO_TESTS`. A changed file
 * runs whole, inside every other filter of the command line, in place of
 * the positionals; the keys and a config change keep the positionals, or
 * the `p` filter over them, except `a`, which runs the command line's
 * selection whole, as `a` and enter do in vitest.
 */
export function planRun(base: RunOptions, filters: WatchFilters, trigger: WatchTrigger): RunOptions {
  if (trigger.kind === 'start') return base;
  const filtered: RunOptions = {
    ...base,
    lastFailed: false,
    files: filters.file === undefined ? base.files : [filters.file],
    grep: filters.title === undefined ? base.grep : [filters.title],
  };
  switch (trigger.kind) {
    case 'files':
      return { ...filtered, files: trigger.files };
    case 'config':
      return filtered;
    case 'key':
      switch (trigger.key) {
        case 'a':
          return { ...filtered, files: base.files, grep: base.grep };
        case 'r':
          return filtered;
        case 'f':
          return { ...filtered, lastFailed: true, passWithNoTests: true };
        case 'u':
          return { ...filtered, updateSnapshots: true };
      }
  }
}

/** What the watcher reads from the config: where the project is, which file configures it, which files are tests. */
export interface WatchScope {
  readonly projectRoot: string;
  readonly configPath: string | undefined;
  /** The config's `tests` globs; none when the config did not load. */
  readonly tests: readonly string[];
}

/** The scope a run leaves behind: its config, or for a config that did not load, the file it would have been. */
export function scopeOf(outcome: RunOutcome, cwd: string, configPath: string | undefined): WatchScope {
  if (outcome.config !== undefined) {
    return { projectRoot: outcome.config.projectRoot, configPath: outcome.config.configPath, tests: outcome.config.tests };
  }
  try {
    const discovered = discoverConfig(cwd, configPath);
    return { projectRoot: discovered.projectRoot, configPath: discovered.configPath, tests: [] };
  } catch {
    return { projectRoot: cwd, configPath: undefined, tests: [] };
  }
}

/** One file change the watcher reports: a test file by its project-relative path, or the config. */
export type WatchChange = { readonly kind: 'test'; readonly file: string } | { readonly kind: 'config' };

/** What the scope makes of a changed path: a test file, the config, or nothing it watches. */
export function classifyChange(scope: WatchScope, globs: CompiledGlobList, absolutePath: string): WatchChange | undefined {
  if (scope.configPath !== undefined && path.resolve(absolutePath) === scope.configPath) return { kind: 'config' };
  const relative = path.relative(scope.projectRoot, absolutePath);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  const file = relative.split(path.sep).join('/');
  if (!globs.include.some((glob) => matchesGlob(glob, file)) || globs.exclude.some((glob) => matchesGlob(glob, file))) return undefined;
  return { kind: 'test', file };
}

/** A directory to watch: recursively where a glob reaches below it, flat where only the config file is there. */
export interface WatchRoot {
  readonly dir: string;
  readonly recursive: boolean;
}

/**
 * The directories the scope's files live under: the literal prefix of each
 * `tests` glob (`tests/**\/*.e2e.ts` watches `tests/`), climbed to the
 * nearest directory that exists so a prefix created later is seen too, and
 * the config's own directory. A root under a recursive root is dropped.
 */
export function watchRoots(scope: WatchScope, globs: CompiledGlobList): WatchRoot[] {
  const roots: WatchRoot[] = [];
  for (const glob of globs.include) {
    let dir = path.join(scope.projectRoot, ...literalPrefix(glob));
    if (literalPrefix(glob).length === glob.segments.length) dir = path.dirname(dir);
    while (!existsSync(dir) && dir !== scope.projectRoot && dir.startsWith(scope.projectRoot)) dir = path.dirname(dir);
    roots.push({ dir, recursive: true });
  }
  if (scope.configPath !== undefined) roots.push({ dir: path.dirname(scope.configPath), recursive: false });
  return roots.filter(
    (root, index) =>
      !roots.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          other.recursive &&
          (other.dir === root.dir ? otherIndex < index || !root.recursive : root.dir.startsWith(`${other.dir}${path.sep}`)),
      ),
  );
}

/** `fs.watch` as the watcher uses it, so a test can stand in for the file system. */
export type WatchFn = (
  dir: string,
  options: { readonly recursive: boolean },
  listener: (event: string, filename: string | Buffer | null) => void,
) => { close(): void };

/** How long after the last change the watcher reports: an editor's save is several events. */
export const DEBOUNCE_MS = 100;

/**
 * Watches the scope's roots and reports each burst of changes once, debounced,
 * as the set of test files touched and whether the config was. Changes that
 * are neither are dropped where they happen.
 */
export class ChangeWatcher {
  private readonly watchers: { close(): void }[] = [];
  private readonly files = new Set<string>();
  private config = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly scope: WatchScope,
    private readonly onChanges: (changes: { readonly files: readonly string[]; readonly config: boolean }) => void,
    private readonly watch: WatchFn = fsWatch,
  ) {}

  /** Starts watching; answers the roots that could be watched. */
  start(): WatchRoot[] {
    const globs = compileGlobList(this.scope.tests);
    const watched: WatchRoot[] = [];
    for (const root of watchRoots(this.scope, globs)) {
      try {
        this.watchers.push(
          this.watch(root.dir, { recursive: root.recursive }, (_event, filename) => {
            if (filename === null) return;
            const change = classifyChange(this.scope, globs, path.join(root.dir, filename.toString()));
            if (change !== undefined) this.record(change);
          }),
        );
        watched.push(root);
      } catch {
        // A root that cannot be watched (gone, or too many watchers) is left out; the keys still rerun.
      }
    }
    return watched;
  }

  /** Stops watching; a burst still pending is dropped. */
  close(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    for (const watcher of this.watchers.splice(0)) watcher.close();
  }

  private record(change: WatchChange): void {
    if (change.kind === 'config') this.config = true;
    else this.files.add(change.file);
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const files = [...this.files].toSorted();
      const config = this.config;
      this.files.clear();
      this.config = false;
      this.onChanges({ files, config });
    }, DEBOUNCE_MS);
  }
}

/** What a burst of changes asks for: the config over everything, else the files that still exist, else nothing. */
export function triggerOf(scope: WatchScope, changes: { readonly files: readonly string[]; readonly config: boolean }): WatchTrigger | undefined {
  if (changes.config) return { kind: 'config' };
  const files = changes.files.filter((file) => existsSync(path.join(scope.projectRoot, file)));
  return files.length === 0 ? undefined : { kind: 'files', files };
}

/** Two triggers that arrived before a run could take them, folded into one. */
export function mergeTriggers(first: WatchTrigger, second: WatchTrigger): WatchTrigger {
  if (first.kind === 'files' && second.kind === 'files') {
    return { kind: 'files', files: [...new Set([...first.files, ...second.files])].toSorted() };
  }
  if (first.kind === 'files' || first.kind === 'start') return second;
  return first;
}

/** A key the terminal delivers, as `readline` names it. */
export interface Keypress {
  readonly name: string | undefined;
  readonly ctrl: boolean;
  readonly sequence?: string | undefined;
}

export type WatchKey = 'a' | 'r' | 'f' | 'u' | 'p' | 't' | 'h' | 'q' | 'cancel' | 'interrupt';

/**
 * The watch key a keypress means, or none. Enter is `a`, as in vitest;
 * space and `c` only cancel a run. Ctrl-C arrives as a keypress in raw
 * mode, not a signal.
 */
export function keyOf(press: Keypress): WatchKey | undefined {
  if (press.ctrl) return press.name === 'c' || press.name === 'd' ? 'interrupt' : undefined;
  switch (press.name) {
    case 'return':
      return 'a';
    case 'space':
    case 'c':
      return 'cancel';
    case 'a':
    case 'r':
    case 'f':
    case 'u':
    case 'p':
    case 't':
    case 'h':
    case 'q':
      return press.name;
    default:
      return undefined;
  }
}

const HELP_LINES: readonly (readonly [key: string, meaning: string])[] = [
  ['a, enter', 'rerun all tests'],
  ['r', 'rerun current pattern tests'],
  ['f', 'rerun only failed tests'],
  ['u', 'update snapshot'],
  ['p', 'filter by a filename'],
  ['t', 'filter by a test name regex pattern'],
  ['q', 'quit'],
];

/** The lines under a finished run: what to press. */
function helpText(pc: ReturnType<typeof picocolors.createColors>, full: boolean): string {
  const press = (key: string, meaning: string): string => `${pc.dim('press')} ${pc.bold(key)} ${pc.dim(`to ${meaning}`)}`;
  if (!full) return `${press('h', 'show help')}${pc.dim(',')} ${press('q', 'quit')}\n`;
  return HELP_LINES.map(([key, meaning]) => `  ${press(key, meaning)}`).join('\n') + '\n';
}

/** The banner above a rerun: why it runs, and how many runs the session has made. */
export function bannerText(pc: ReturnType<typeof picocolors.createColors>, trigger: WatchTrigger, filters: WatchFilters, count: number): string {
  const why =
    trigger.kind === 'files'
      ? trigger.files.join(', ')
      : trigger.kind === 'config'
        ? 'config changed'
        : trigger.kind === 'key'
          ? { a: 'all tests', r: 'current pattern', f: 'failed tests', u: 'update snapshot' }[trigger.key]
          : 'start';
  const applied = [
    ...(filters.file === undefined ? [] : [`files: ${filters.file}`]),
    ...(filters.title === undefined ? [] : [`title: ${filters.title.source}`]),
  ];
  const filter = applied.length === 0 ? '' : pc.dim(` (${applied.join(', ')})`);
  return `${pc.inverse(pc.bold(' RERUN '))} ${why}${filter} ${pc.dim(`x${count}`)}\n\n`;
}

/** ANSI: clear the screen and the scrollback, cursor home; a rerun starts on a clean terminal as vitest's does. */
const CLEAR_SCREEN = '\x1b[2J\x1b[3J\x1b[H';

export interface WatchSessionOptions {
  /** The run options the command line parsed, without the signals and the process output; the session adds those. */
  readonly base: RunOptions;
  readonly cwd: string;
  readonly signals: SignalLadder;
  /**
   * Executes one run: the real runner, with the session's signals and the
   * process's output, and the telemetry record. `cancel` aborts this run
   * alone, as the interrupt would, when a key asks for it.
   */
  readonly run: (options: RunOptions, cancel: AbortSignal) => Promise<RunOutcome>;
  /** The keyboard, when stdin is a terminal; without it only file changes rerun. */
  readonly stdin: NodeJS.ReadStream | undefined;
  /** Writes the session's own lines to the terminal. */
  readonly write: (text: string) => void;
  readonly pc: ReturnType<typeof picocolors.createColors>;
  /** Clears the terminal before a rerun; off when stdout is not a terminal. */
  readonly clear: boolean;
  readonly watch?: WatchFn | undefined;
}

/**
 * The watch loop: runs, then waits for a change or a key, and runs again,
 * until a quit or a signal. Answers the exit code of the last run that
 * finished. A change that lands during a run is kept and runs next; a key
 * during a run cancels it, as in vitest, and the loop waits again, while
 * Ctrl-C interrupts it as a signal would and ends the session.
 */
export async function watchSession(options: WatchSessionOptions): Promise<number> {
  const { pc, signals } = options;
  let filters = NO_FILTERS;
  let trigger: WatchTrigger = { kind: 'start' };
  /** What arrived while a run or a prompt had the terminal: the next run's trigger. */
  let pending: WatchTrigger | undefined;
  let count = 0;
  let scope: WatchScope | undefined;
  let watcher: ChangeWatcher | undefined;
  let running: AbortController | undefined;
  let wake: ((value: Wake) => void) | undefined;
  let exitCode = 0;

  const arrive = (next: WatchTrigger): void => {
    if (wake === undefined) pending = pending === undefined ? next : mergeTriggers(pending, next);
    else wake(next);
  };
  const keyboard = options.stdin === undefined ? undefined : new Keyboard(options.stdin);
  keyboard?.listen((key) => {
    if (key === 'interrupt') {
      signals.escalate();
      return;
    }
    if (running !== undefined) {
      running.abort();
      return;
    }
    switch (key) {
      case 'q':
        wake?.('quit');
        return;
      case 'h':
        options.write(helpText(pc, true));
        return;
      case 'p':
      case 't':
        wake?.(key);
        return;
      case 'a':
        filters = NO_FILTERS;
        arrive({ kind: 'key', key });
        return;
      case 'r':
      case 'f':
      case 'u':
        arrive({ kind: 'key', key });
    }
  });
  const quit = (): void => wake?.('quit');
  signals.interruptSignal.addEventListener('abort', quit, { once: true });
  const waiting = (): void => options.write(`\n${pc.dim('Waiting for file changes...')}\n  ${helpText(pc, false)}`);
  const terminal = terminalStream(options.write);

  try {
    for (;;) {
      const cancel = new AbortController();
      running = cancel;
      count += 1;
      if (trigger.kind !== 'start') {
        options.write(`${options.clear ? CLEAR_SCREEN : '\n'}${bannerText(pc, trigger, filters, count)}`);
      }
      const outcome = await options.run(planRun(options.base, filters, trigger), cancel.signal);
      running = undefined;
      if (signals.interruptSignal.aborted) {
        exitCode = outcome.exitCode;
        break;
      }
      if (cancel.signal.aborted) options.write(`\n${pc.yellow('run cancelled')}\n`);
      else exitCode = outcome.exitCode;

      const next = scopeOf(outcome, options.cwd, options.base.configPath);
      if (scope === undefined || !sameScope(scope, next)) {
        watcher?.close();
        scope = next;
        watcher = new ChangeWatcher(
          scope,
          (changes) => {
            const change = triggerOf(scope!, changes);
            if (change !== undefined) arrive(change);
          },
          options.watch,
        );
        const roots = watcher.start();
        if (roots.length === 0) options.write(`${pc.yellow('nothing to watch')}: no test directory or config file to watch; the keys still rerun\n`);
      }

      let woken: WatchTrigger | 'quit' | undefined;
      while (woken === undefined) {
        if (pending !== undefined) {
          woken = pending;
          pending = undefined;
          break;
        }
        waiting();
        const value = await new Promise<Wake>((resolve) => {
          wake = (woke) => {
            wake = undefined;
            resolve(woke);
          };
        });
        if (value !== 'p' && value !== 't') {
          woken = value;
          break;
        }
        // The prompt owns the terminal: keys wait, and so does a change, in `pending`.
        keyboard?.pause();
        const answer = await (value === 'p' ? promptFile(filters, terminal) : promptTitle(filters, terminal));
        keyboard?.resume();
        if (answer !== undefined) {
          filters = answer;
          woken = { kind: 'key', key: 'r' };
        }
      }
      if (woken === 'quit') break;
      trigger = woken;
    }
  } finally {
    signals.interruptSignal.removeEventListener('abort', quit);
    watcher?.close();
    keyboard?.close();
  }
  return exitCode;
}

/** What ends an idle wait: a trigger, a prompt to open, or the end of the session. */
type Wake = WatchTrigger | 'quit' | 'p' | 't';

function sameScope(a: WatchScope, b: WatchScope): boolean {
  return a.projectRoot === b.projectRoot && a.configPath === b.configPath && a.tests.length === b.tests.length && a.tests.every((glob, i) => glob === b.tests[i]);
}

/** `p`: the positional the next runs select with; empty clears it. Answers nothing when cancelled. */
async function promptFile(filters: WatchFilters, output: Writable): Promise<WatchFilters | undefined> {
  const answer = await clack.text({
    output,
    message: 'Filter by a file name, path, or glob (empty clears the filter)',
    placeholder: 'signup',
    defaultValue: '',
    initialValue: filters.file ?? '',
  });
  if (clack.isCancel(answer)) return undefined;
  const value = answer.trim();
  return { ...filters, file: value === '' ? undefined : value };
}

/** `t`: the title pattern the next runs select with; empty clears it. Answers nothing when cancelled or invalid. */
async function promptTitle(filters: WatchFilters, output: Writable): Promise<WatchFilters | undefined> {
  const answer = await clack.text({
    output,
    message: 'Filter by a test name regex pattern (empty clears the filter)',
    placeholder: 'checkout',
    defaultValue: '',
    initialValue: filters.title?.source ?? '',
    validate: (value) => invalidPattern(value ?? ''),
  });
  if (clack.isCancel(answer)) return undefined;
  const value = answer.trim();
  return { ...filters, title: value === '' ? undefined : new RegExp(value) };
}

/**
 * The terminal as a stream, for the prompts: `write` reaches stdout past
 * the run's redaction, which holds a line's tail for a value a later write
 * could complete, so a prompt's last escape sequence would otherwise print
 * under the next run as runner output.
 */
function terminalStream(write: (text: string) => void): Writable {
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      write(chunk.toString());
      callback();
    },
  });
  Object.defineProperty(stream, 'columns', { get: () => process.stdout.columns });
  return stream;
}

/** Why `source` is not a regular expression, or nothing when it is. */
function invalidPattern(source: string): string | undefined {
  try {
    RegExp(source);
    return undefined;
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
}

/** Raw-mode stdin delivering watch keys, pausable while a prompt owns the terminal. */
class Keyboard {
  private handler: ((key: WatchKey) => void) | undefined;
  private readonly onKeypress = (_chunk: unknown, press: Keypress | undefined): void => {
    if (press === undefined || this.handler === undefined) return;
    const key = keyOf(press);
    if (key !== undefined) this.handler(key);
  };

  constructor(private readonly stdin: NodeJS.ReadStream) {
    emitKeypressEvents(stdin);
  }

  listen(handler: (key: WatchKey) => void): void {
    this.handler = handler;
    this.resume();
  }

  resume(): void {
    this.stdin.setRawMode?.(true);
    this.stdin.on('keypress', this.onKeypress);
    this.stdin.resume();
  }

  pause(): void {
    this.stdin.off('keypress', this.onKeypress);
    this.stdin.setRawMode?.(false);
  }

  close(): void {
    this.pause();
    this.stdin.pause();
  }
}
